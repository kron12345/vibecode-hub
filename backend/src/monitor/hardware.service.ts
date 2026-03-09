import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { execFile } from 'child_process';
import { readFile } from 'fs/promises';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface GpuStats {
  index: number;
  name: string;
  temp: number;
  fanSpeed: number;
  powerDraw: number;
  gpuUtil: number;
  memUtil: number;
  gpuClock: number;
  memClock: number;
}

export interface CpuStats {
  temp: number;
  load1: number;
  load5: number;
  load15: number;
  powerDraw: number;
}

export interface RamStats {
  totalMb: number;
  usedMb: number;
  availableMb: number;
  usedPercent: number;
}

export interface HardwareSnapshot {
  gpus: GpuStats[];
  cpu: CpuStats;
  ram: RamStats;
  timestamp: number;
}

@Injectable()
export class HardwareService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HardwareService.name);
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private latestSnapshot: HardwareSnapshot | null = null;
  private listeners: Array<(snapshot: HardwareSnapshot) => void> = [];

  /** How often to poll hardware stats (ms) */
  private readonly POLL_MS = 3000;

  /** Ring buffer for sparkline history (last 60 snapshots = ~3 min) */
  private history: HardwareSnapshot[] = [];
  private readonly MAX_HISTORY = 60;

  /** RAPL energy tracking for CPU power calculation */
  private lastEnergyUj = 0;
  private lastEnergyTime = 0;
  private readonly RAPL_PATH =
    '/sys/class/powercap/intel-rapl:0/energy_uj';

  async onModuleInit() {
    // Take initial snapshot
    this.latestSnapshot = await this.collectSnapshot();
    this.pushHistory(this.latestSnapshot);

    // Start polling
    this.pollInterval = setInterval(async () => {
      try {
        this.latestSnapshot = await this.collectSnapshot();
        this.pushHistory(this.latestSnapshot);
        this.notifyListeners(this.latestSnapshot);
      } catch (err) {
        this.logger.warn(`Hardware poll failed: ${err.message}`);
      }
    }, this.POLL_MS);

    this.logger.log('Hardware monitoring started (3s interval)');
  }

  onModuleDestroy() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  /** Get latest snapshot (non-async, from cache) */
  getLatest(): HardwareSnapshot | null {
    return this.latestSnapshot;
  }

  /** Get history ring buffer for sparkline charts */
  getHistory(): HardwareSnapshot[] {
    return [...this.history];
  }

  /** Register a listener for real-time pushes */
  onSnapshot(fn: (snapshot: HardwareSnapshot) => void) {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  // ─── Data Collection ─────────────────────────────────────

  private async collectSnapshot(): Promise<HardwareSnapshot> {
    const [gpus, cpu, ram] = await Promise.all([
      this.readGpuStats(),
      this.readCpuStats(),
      this.readRamStats(),
    ]);
    return { gpus, cpu, ram, timestamp: Date.now() };
  }

  private async readGpuStats(): Promise<GpuStats[]> {
    try {
      const { stdout } = await execFileAsync('nvtop', ['-s'], {
        timeout: 5000,
      });
      const raw: any[] = JSON.parse(stdout);
      return raw.map((gpu, i) => ({
        index: i,
        name: gpu.device_name ?? `GPU ${i}`,
        temp: parseInt(gpu.temp) || 0,
        fanSpeed: parseInt(gpu.fan_speed) || 0,
        powerDraw: parseInt(gpu.power_draw) || 0,
        gpuUtil: parseInt(gpu.gpu_util) || 0,
        memUtil: parseInt(gpu.mem_util) || 0,
        gpuClock: parseInt(gpu.gpu_clock) || 0,
        memClock: parseInt(gpu.mem_clock) || 0,
      }));
    } catch (err) {
      this.logger.warn(`nvtop failed: ${err.message}`);
      return [];
    }
  }

  private async readCpuStats(): Promise<CpuStats> {
    const [temp, load, powerDraw] = await Promise.all([
      this.readCpuTemp(),
      this.readCpuLoad(),
      this.readCpuPower(),
    ]);
    return { temp, ...load, powerDraw };
  }

  private async readCpuTemp(): Promise<number> {
    try {
      // k10temp on AMD — Tctl sensor
      const raw = await readFile(
        '/sys/class/hwmon/hwmon2/temp1_input',
        'utf8',
      );
      return Math.round(parseInt(raw) / 1000);
    } catch {
      // Fallback: try all hwmon dirs
      try {
        const { stdout } = await execFileAsync('cat', [
          '/sys/class/thermal/thermal_zone0/temp',
        ], { timeout: 2000 });
        return Math.round(parseInt(stdout) / 1000);
      } catch {
        return 0;
      }
    }
  }

  private async readCpuLoad(): Promise<{
    load1: number;
    load5: number;
    load15: number;
  }> {
    try {
      const raw = await readFile('/proc/loadavg', 'utf8');
      const [l1, l5, l15] = raw.split(' ').map(parseFloat);
      return { load1: l1, load5: l5, load15: l15 };
    } catch {
      return { load1: 0, load5: 0, load15: 0 };
    }
  }

  private async readCpuPower(): Promise<number> {
    try {
      const raw = await readFile(this.RAPL_PATH, 'utf8');
      const energyUj = parseInt(raw);
      const now = Date.now();

      if (this.lastEnergyTime === 0) {
        // First reading — store baseline, return 0
        this.lastEnergyUj = energyUj;
        this.lastEnergyTime = now;
        return 0;
      }

      const dtMs = now - this.lastEnergyTime;
      if (dtMs <= 0) return 0;

      let deltaUj = energyUj - this.lastEnergyUj;
      // Handle counter wraparound (max_energy_range_uj ~ 65.5 TJ)
      if (deltaUj < 0) {
        deltaUj += 65532610987; // max_energy_range_uj from sysfs
      }

      this.lastEnergyUj = energyUj;
      this.lastEnergyTime = now;

      // µJ / ms = mW → divide by 1000 for W
      const watts = deltaUj / dtMs / 1000;
      return Math.round(watts);
    } catch {
      return 0;
    }
  }

  private async readRamStats(): Promise<RamStats> {
    try {
      const raw = await readFile('/proc/meminfo', 'utf8');
      const lines = raw.split('\n');
      const get = (key: string) => {
        const line = lines.find((l) => l.startsWith(key));
        if (!line) return 0;
        return parseInt(line.split(/\s+/)[1]) || 0; // kB
      };
      const totalKb = get('MemTotal:');
      const availableKb = get('MemAvailable:');
      const usedKb = totalKb - availableKb;
      const totalMb = Math.round(totalKb / 1024);
      const availableMb = Math.round(availableKb / 1024);
      const usedMb = Math.round(usedKb / 1024);
      const usedPercent = totalKb > 0 ? Math.round((usedKb / totalKb) * 100) : 0;
      return { totalMb, usedMb, availableMb, usedPercent };
    } catch {
      return { totalMb: 0, usedMb: 0, availableMb: 0, usedPercent: 0 };
    }
  }

  private pushHistory(snapshot: HardwareSnapshot) {
    this.history.push(snapshot);
    if (this.history.length > this.MAX_HISTORY) {
      this.history.shift();
    }
  }

  private notifyListeners(snapshot: HardwareSnapshot) {
    for (const fn of this.listeners) {
      try {
        fn(snapshot);
      } catch {
        // ignore listener errors
      }
    }
  }
}
