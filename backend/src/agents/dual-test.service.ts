import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../llm/llm.service';
import { LlmMessage, LlmCompletionResult } from '../llm/llm.interfaces';
import { AgentRoleConfig } from '../settings/system-settings.service';

/**
 * A finding with severity — common to all test/review result types.
 */
export interface DualFinding {
  severity: 'info' | 'warning' | 'critical';
  /** Primary key for deduplication (e.g. file + message hash) */
  dedupeKey: string;
  [key: string]: unknown;
}

export interface DualLlmResult {
  primary: LlmCompletionResult;
  secondary?: LlmCompletionResult;
  /** Which providers were called */
  providers: { primary: string; secondary?: string };
}

/**
 * Service for dual-testing: call two LLM providers and merge/consensus results.
 *
 * Three strategies:
 * - merge: Union of findings (deduplicated by dedupeKey)
 * - consensus: Only findings that both providers agree on (by dedupeKey)
 * - enrich: Primary runs first, secondary validates and can add to primary's findings
 */
@Injectable()
export class DualTestService {
  private readonly logger = new Logger(DualTestService.name);

  constructor(private readonly llmService: LlmService) {}

  /**
   * Call primary and (if configured) secondary LLM provider.
   * Returns both raw results for agent-specific parsing.
   */
  async callDual(
    config: AgentRoleConfig,
    messages: LlmMessage[],
  ): Promise<DualLlmResult> {
    // Always call primary
    const primary = await this.llmService.complete({
      provider: config.provider,
      model: config.model,
      messages,
      temperature: config.parameters.temperature,
      maxTokens: config.parameters.maxTokens,
    });

    const result: DualLlmResult = {
      primary,
      providers: { primary: `${config.provider}/${config.model}` },
    };

    // Call secondary if dual-testing is configured
    if (config.dualProvider && config.dualModel) {
      this.logger.log(
        `Dual-testing: calling secondary ${config.dualProvider}/${config.dualModel} (strategy: ${config.dualStrategy ?? 'merge'})`,
      );

      const secondary = await this.llmService.complete({
        provider: config.dualProvider,
        model: config.dualModel,
        messages,
        temperature: config.parameters.temperature,
        maxTokens: config.parameters.maxTokens,
      });

      result.secondary = secondary;
      result.providers.secondary = `${config.dualProvider}/${config.dualModel}`;
    }

    return result;
  }

  /**
   * Merge findings from two providers using the configured strategy.
   *
   * @param primaryFindings Findings from primary provider
   * @param secondaryFindings Findings from secondary provider
   * @param strategy Merge strategy
   * @param buildDedupeKey Function to generate deduplication key for a finding
   */
  mergeFindings<T extends { severity: string }>(
    primaryFindings: T[],
    secondaryFindings: T[],
    strategy: 'merge' | 'consensus' | 'enrich',
    buildDedupeKey: (f: T) => string,
  ): { merged: T[]; stats: MergeStats } {
    const primaryKeys = new Set(primaryFindings.map(buildDedupeKey));
    const secondaryKeys = new Set(secondaryFindings.map(buildDedupeKey));

    let merged: T[];
    const stats: MergeStats = {
      primaryCount: primaryFindings.length,
      secondaryCount: secondaryFindings.length,
      mergedCount: 0,
      strategy,
    };

    switch (strategy) {
      case 'merge': {
        // Union: all findings from both, deduplicated
        const seen = new Set<string>();
        merged = [];
        for (const f of [...primaryFindings, ...secondaryFindings]) {
          const key = buildDedupeKey(f);
          if (!seen.has(key)) {
            seen.add(key);
            merged.push(f);
          }
        }
        stats.mergedCount = merged.length;
        this.logger.log(
          `Merge strategy: ${primaryFindings.length} primary + ${secondaryFindings.length} secondary → ${merged.length} unique`,
        );
        break;
      }

      case 'consensus': {
        // Intersection: only findings both providers agree on
        merged = primaryFindings.filter((f) => {
          const key = buildDedupeKey(f);
          return secondaryKeys.has(key);
        });
        stats.mergedCount = merged.length;
        this.logger.log(
          `Consensus strategy: ${primaryFindings.length} primary ∩ ${secondaryFindings.length} secondary → ${merged.length} agreed`,
        );
        break;
      }

      case 'enrich': {
        // Primary findings + NEW findings from secondary (not in primary)
        merged = [...primaryFindings];
        for (const f of secondaryFindings) {
          const key = buildDedupeKey(f);
          if (!primaryKeys.has(key)) {
            merged.push(f);
          }
        }
        stats.mergedCount = merged.length;
        this.logger.log(
          `Enrich strategy: ${primaryFindings.length} primary + ${merged.length - primaryFindings.length} new from secondary → ${merged.length} total`,
        );
        break;
      }

      default:
        merged = primaryFindings;
        stats.mergedCount = merged.length;
    }

    return { merged, stats };
  }

  /**
   * Determine approval/pass from merged findings using standard rules.
   * APPROVE/PASS if: 0 critical AND ≤ maxWarnings warnings
   */
  determineApproval(
    findings: Array<{ severity: string }>,
    maxWarnings = 2,
  ): boolean {
    const criticals = findings.filter((f) => f.severity === 'critical').length;
    const warnings = findings.filter((f) => f.severity === 'warning').length;
    return criticals === 0 && warnings <= maxWarnings;
  }

  /**
   * Check if dual-testing is configured for a role.
   */
  isDualConfigured(config: AgentRoleConfig): boolean {
    return !!(config.dualProvider && config.dualModel);
  }
}

export interface MergeStats {
  primaryCount: number;
  secondaryCount: number;
  mergedCount: number;
  strategy: string;
}
