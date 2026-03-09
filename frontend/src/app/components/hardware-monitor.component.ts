import { Component, computed, inject, Input, OnInit, OnDestroy } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { MonitorSocketService } from '../services/monitor-socket.service';
import { IconComponent } from './icon.component';
import { TranslatePipe } from '../pipes/translate.pipe';

@Component({
  selector: 'app-hardware-monitor',
  imports: [DecimalPipe, IconComponent, TranslatePipe],
  template: `
    @if (hw(); as snap) {
      <div class="grid gap-3" [class]="layout === 'horizontal' ? 'grid-cols-2 lg:grid-cols-4' : 'grid-cols-1'">
        <!-- GPUs -->
        @for (gpu of snap.gpus; track gpu.index) {
          <div class="glass rounded-2xl p-4 animate-in" [style.animation-delay]="(gpu.index * 0.05) + 's'">
            <div class="flex items-center justify-between mb-3">
              <span class="text-[10px] font-bold uppercase tracking-widest text-slate-500">GPU {{ gpu.index }}</span>
              <app-icon name="cpu" [size]="14" class="text-slate-600" />
            </div>
            <div class="flex items-end gap-2 mb-2">
              <span class="text-2xl font-mono font-bold" [class]="tempColor(gpu.temp)">{{ gpu.temp }}°</span>
              <span class="text-xs text-slate-500 mb-0.5">{{ gpu.powerDraw }}W</span>
            </div>
            <!-- Utilization bars -->
            <div class="space-y-1.5">
              <div class="flex items-center gap-2">
                <span class="text-[10px] text-slate-500 w-10">GPU</span>
                <div class="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                  <div class="h-full rounded-full transition-all duration-500" [class]="utilBarColor(gpu.gpuUtil)" [style.width.%]="gpu.gpuUtil"></div>
                </div>
                <span class="text-[10px] font-mono text-slate-400 w-8 text-right">{{ gpu.gpuUtil }}%</span>
              </div>
              <div class="flex items-center gap-2">
                <span class="text-[10px] text-slate-500 w-10">VRAM</span>
                <div class="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                  <div class="h-full rounded-full transition-all duration-500" [class]="utilBarColor(gpu.memUtil)" [style.width.%]="gpu.memUtil"></div>
                </div>
                <span class="text-[10px] font-mono text-slate-400 w-8 text-right">{{ gpu.memUtil }}%</span>
              </div>
            </div>
            <!-- Sparkline -->
            @if (gpuSparkline(gpu.index); as points) {
              <svg class="w-full h-8 mt-2" viewBox="0 0 120 32" preserveAspectRatio="none">
                <polyline [attr.points]="points" fill="none" stroke="currentColor" stroke-width="1.5" class="text-indigo-500/50" />
              </svg>
            }
          </div>
        }

        <!-- CPU -->
        <div class="glass rounded-2xl p-4 animate-in" style="animation-delay: 0.1s">
          <div class="flex items-center justify-between mb-3">
            <span class="text-[10px] font-bold uppercase tracking-widest text-slate-500">{{ 'monitor.cpu' | translate }}</span>
            <app-icon name="activity" [size]="14" class="text-slate-600" />
          </div>
          <div class="flex items-end gap-2 mb-2">
            <span class="text-2xl font-mono font-bold" [class]="tempColor(snap.cpu.temp)">{{ snap.cpu.temp }}°</span>
          </div>
          <div class="space-y-1.5">
            <div class="flex items-center gap-2">
              <span class="text-[10px] text-slate-500 w-10">Load</span>
              <div class="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                <div class="h-full rounded-full transition-all duration-500" [class]="utilBarColor(cpuPercent())" [style.width.%]="cpuPercent()"></div>
              </div>
              <span class="text-[10px] font-mono text-slate-400 w-8 text-right">{{ snap.cpu.load1 | number:'1.1-1' }}</span>
            </div>
          </div>
          @if (cpuSparkline(); as points) {
            <svg class="w-full h-8 mt-2" viewBox="0 0 120 32" preserveAspectRatio="none">
              <polyline [attr.points]="points" fill="none" stroke="currentColor" stroke-width="1.5" class="text-emerald-500/50" />
            </svg>
          }
        </div>

        <!-- RAM -->
        <div class="glass rounded-2xl p-4 animate-in" style="animation-delay: 0.15s">
          <div class="flex items-center justify-between mb-3">
            <span class="text-[10px] font-bold uppercase tracking-widest text-slate-500">{{ 'monitor.ram' | translate }}</span>
            <app-icon name="hard-drive" [size]="14" class="text-slate-600" />
          </div>
          <div class="flex items-end gap-2 mb-2">
            <span class="text-2xl font-mono font-bold text-violet-400">{{ snap.ram.usedPercent }}%</span>
            <span class="text-xs text-slate-500 mb-0.5">{{ (snap.ram.usedMb / 1024) | number:'1.0-0' }} / {{ (snap.ram.totalMb / 1024) | number:'1.0-0' }} GB</span>
          </div>
          <div class="space-y-1.5">
            <div class="flex items-center gap-2">
              <span class="text-[10px] text-slate-500 w-10">Used</span>
              <div class="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                <div class="h-full bg-violet-500 rounded-full transition-all duration-500" [style.width.%]="snap.ram.usedPercent"></div>
              </div>
            </div>
          </div>
          @if (ramSparkline(); as points) {
            <svg class="w-full h-8 mt-2" viewBox="0 0 120 32" preserveAspectRatio="none">
              <polyline [attr.points]="points" fill="none" stroke="currentColor" stroke-width="1.5" class="text-violet-500/50" />
            </svg>
          }
        </div>
      </div>
    } @else {
      <div class="glass rounded-2xl p-6 text-center text-slate-500">
        <app-icon name="loader-2" [size]="20" class="animate-spin inline-block mb-2" />
        <p class="text-sm">{{ 'common.loading' | translate }}</p>
      </div>
    }
  `,
})
export class HardwareMonitorComponent implements OnInit, OnDestroy {
  @Input() layout: 'horizontal' | 'vertical' = 'horizontal';

  private monitor = inject(MonitorSocketService);
  readonly hw = this.monitor.hardware;
  private readonly hist = this.monitor.history;

  /** CPU load as percentage (load1 / nproc * 100) — capped at 100 */
  readonly cpuPercent = computed(() => {
    const load = this.hw()?.cpu.load1 ?? 0;
    return Math.min(Math.round((load / 16) * 100), 100); // 16 cores assumed
  });

  ngOnInit() {
    this.monitor.connect();
  }

  ngOnDestroy() {
    // Don't disconnect — other components may use the same socket
  }

  tempColor(temp: number): string {
    if (temp >= 80) return 'text-red-400';
    if (temp >= 65) return 'text-amber-400';
    return 'text-emerald-400';
  }

  utilBarColor(percent: number): string {
    if (percent >= 90) return 'bg-red-500';
    if (percent >= 70) return 'bg-amber-500';
    return 'bg-indigo-500';
  }

  gpuSparkline(gpuIndex: number): string | null {
    return this.buildSparkline(this.hist(), (s) => s.gpus[gpuIndex]?.gpuUtil ?? 0);
  }

  cpuSparkline = computed(() =>
    this.buildSparkline(this.hist(), (s) => Math.min((s.cpu.load1 / 16) * 100, 100)),
  );

  ramSparkline = computed(() =>
    this.buildSparkline(this.hist(), (s) => s.ram.usedPercent),
  );

  private buildSparkline(
    data: any[],
    getValue: (s: any) => number,
  ): string | null {
    if (data.length < 2) return null;
    const w = 120;
    const h = 32;
    const step = w / (data.length - 1);
    return data
      .map((s, i) => {
        const v = getValue(s);
        const y = h - (v / 100) * h;
        return `${(i * step).toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  }
}
