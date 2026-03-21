import {
  Component,
  input,
  output,
} from '@angular/core';
import { PipelineFailureSummary } from '../../services/api.service';
import { IconComponent } from '../../components/icon.component';
import { TranslatePipe } from '../../pipes/translate.pipe';

/** Agent role config — icon, color, i18n key */
export const AGENT_CONFIG: Record<string, { icon: string; color: string; labelKey: string }> = {
  INTERVIEWER:       { icon: 'message-circle', color: 'sky', labelKey: 'agents.interviewer' },
  ARCHITECT:         { icon: 'pen-tool', color: 'violet', labelKey: 'agents.architect' },
  ISSUE_COMPILER:    { icon: 'list-checks', color: 'amber', labelKey: 'agents.issueCompiler' },
  CODER:             { icon: 'code-2', color: 'indigo', labelKey: 'agents.developer' },
  CODE_REVIEWER:     { icon: 'search-check', color: 'emerald', labelKey: 'agents.reviewer' },
  UI_TESTER:         { icon: 'monitor-check', color: 'pink', labelKey: 'agents.uiTester' },
  FUNCTIONAL_TESTER: { icon: 'test-tubes', color: 'teal', labelKey: 'agents.functionalTester' },
  PEN_TESTER:        { icon: 'shield-alert', color: 'red', labelKey: 'agents.pentester' },
  DOCUMENTER:        { icon: 'file-text', color: 'cyan', labelKey: 'agents.docs' },
  DEVOPS:            { icon: 'rocket', color: 'orange', labelKey: 'agents.devops' },
};

export interface AgentEntry {
  role: string;
  icon: string;
  color: string;
  labelKey: string;
  instance?: {
    status: string;
    provider?: string;
    model?: string;
  };
}

@Component({
  selector: 'app-pipeline-view',
  imports: [IconComponent, TranslatePipe],
  template: `
    <!-- Pipeline Failure Banner -->
    @if (showFailure() && failure()) {
      <div class="mb-4 rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 animate-in stagger-4">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <h3 class="text-sm font-semibold text-rose-300">{{ 'project.pipelinePausedTitle' | translate }}</h3>
            <p class="text-xs text-rose-200/80 mt-1">{{ 'project.pipelinePausedHint' | translate }}</p>
            <div class="text-xs text-rose-100/90 mt-2 space-y-1">
              <div><span class="text-rose-300/80">{{ 'project.failedTask' | translate }}:</span> {{ failure()!.taskType }}</div>
              @if (failure()!.issueTitle) {
                <div>
                  <span class="text-rose-300/80">Issue:</span>
                  {{ failure()!.issueTitle }}
                  @if (failure()!.issueGitlabIid) {
                    (#{{ failure()!.issueGitlabIid }})
                  }
                </div>
              }
              <div><span class="text-rose-300/80">{{ 'project.failedReason' | translate }}:</span> {{ failure()!.reason }}</div>
              <div><span class="text-rose-300/80">{{ 'project.failedAt' | translate }}:</span> {{ formatDate(failure()!.failedAt) }}</div>
            </div>
          </div>
          <button
            (click)="resume.emit()"
            [disabled]="resuming()"
            class="shrink-0 px-3 py-2 rounded-lg bg-rose-500/20 border border-rose-400/40 text-rose-100 text-xs font-medium hover:bg-rose-500/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {{ (resuming() ? 'project.resuming' : 'project.resumePipeline') | translate }}
          </button>
        </div>
      </div>
    }

    <!-- Agent Pipeline -->
    <div class="glass card-glow rounded-[2rem] p-6 mb-6 relative overflow-hidden animate-in stagger-4">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-sm font-bold text-slate-500 uppercase tracking-widest">{{ 'project.agentPipeline' | translate }}</h2>
        @if (hasWorkingAgent()) {
          <span class="text-[10px] text-indigo-400 font-mono animate-pulse uppercase tracking-widest shrink-0">{{ 'project.processing' | translate }}</span>
        }
      </div>

      <div class="relative overflow-x-auto pb-2">
        <div class="relative flex items-center gap-3 min-w-max">
          <!-- Connection Line -->
          <div class="absolute top-1/2 left-0 w-full h-[2px] bg-slate-800 -translate-y-1/2 z-0"></div>
          @if (hasWorkingAgent()) {
            <div class="absolute top-1/2 left-0 w-full h-[2px] -translate-y-1/2 z-0 pulse-line"></div>
          }

          <!-- Agent Cards -->
          @for (entry of agentEntries(); track entry.role) {
            <div
              class="w-[130px] shrink-0 glass p-3 rounded-2xl z-10 transition-all duration-500 border border-transparent"
              [class]="entry.instance?.status === 'WORKING' ? 'agent-glow-' + entry.color + ' -translate-y-1' : 'opacity-50'"
            >
              <div class="flex items-center gap-2 mb-1.5">
                <div
                  class="p-2 rounded-xl shrink-0"
                  [class]="'bg-' + entry.color + '-500/20 text-' + entry.color + '-400'"
                >
                  @if (entry.instance?.status === 'WORKING') {
                    <div class="activity-ring">
                      <app-icon [name]="entry.icon" [size]="16" />
                    </div>
                  } @else {
                    <app-icon [name]="entry.icon" [size]="16" />
                  }
                </div>
                <span class="font-semibold text-xs text-white truncate" [title]="entry.labelKey | translate">{{ entry.labelKey | translate }}</span>
              </div>
              <p class="text-[10px] text-slate-600 font-mono mb-1.5 truncate"
                 [title]="(entry.instance?.provider ?? '') + (entry.instance?.model ? ' · ' + entry.instance!.model : '')">
                {{ entry.instance?.provider ?? ('project.notAssigned' | translate) }}
                @if (entry.instance?.model) {
                  · {{ entry.instance!.model }}
                }
              </p>
              @if (entry.instance?.status === 'WORKING') {
                <span class="text-[10px] font-mono animate-pulse uppercase tracking-widest"
                  [class]="'text-' + entry.color + '-400'"
                >
                  {{ 'project.working' | translate }}
                </span>
              } @else if (entry.instance) {
                <span class="text-[10px] text-slate-600 font-mono uppercase">{{ entry.instance.status }}</span>
              }
            </div>
          }
        </div>
      </div>
    </div>
  `,
})
export class PipelineViewComponent {
  /** All agent entries built from AGENT_CONFIG + live instances */
  agentEntries = input.required<AgentEntry[]>();

  /** Whether at least one agent is currently working */
  hasWorkingAgent = input.required<boolean>();

  /** Latest pipeline failure (if any) */
  failure = input<PipelineFailureSummary | null>(null);

  /** Whether to show the failure banner */
  showFailure = input(false);

  /** Whether resume is in progress */
  resuming = input(false);

  /** Emitted when user clicks the resume button */
  resume = output<void>();

  formatDate(dateStr: string): string {
    return new Date(dateStr).toLocaleDateString(undefined, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
}
