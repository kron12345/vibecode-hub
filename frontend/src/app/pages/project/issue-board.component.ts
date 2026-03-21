import {
  Component,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  ApiService,
  Issue,
  IssueComment,
} from '../../services/api.service';
import { IconComponent } from '../../components/icon.component';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { TranslateService } from '../../services/translate.service';

/** Issue status steps for progress dots */
const ISSUE_STEPS = ['OPEN', 'IN_PROGRESS', 'IN_REVIEW', 'TESTING', 'DONE', 'CLOSED'];

export interface MilestoneGroup {
  id: string;
  title: string;
  sortOrder: number;
  issues: Issue[];
}

@Component({
  selector: 'app-issue-board',
  imports: [FormsModule, IconComponent, TranslatePipe],
  styles: [`
    .animate-slide-in-right {
      animation: slideInRight 0.25s ease-out;
    }
    @keyframes slideInRight {
      from { transform: translateX(100%); }
      to { transform: translateX(0); }
    }
  `],
  template: `
    <!-- Issues (grouped by milestones) -->
    <div class="glass rounded-3xl p-5 max-h-[65vh] overflow-y-auto animate-in stagger-5">
      <div class="flex items-center justify-between mb-4">
        <h3 class="text-sm font-bold text-slate-500 uppercase tracking-widest">{{ 'project.issues' | translate }}</h3>
        <span class="text-[10px] font-mono text-slate-600">{{ issues().length }}</span>
      </div>

      @if (issuesByMilestone().length > 0) {
        @for (group of issuesByMilestone(); track group.id) {
          <!-- Milestone Header -->
          <button
            class="w-full flex items-center justify-between gap-2 px-3 py-2 mb-1 rounded-xl bg-amber-500/10 border border-amber-500/20 hover:bg-amber-500/15 transition-all cursor-pointer"
            (click)="toggleMilestone(group.id)"
          >
            <div class="flex items-center gap-2 min-w-0">
              <app-icon
                [name]="isMilestoneExpanded(group.id) ? 'chevron-down' : 'chevron-right'"
                [size]="14"
                class="text-amber-400 shrink-0"
              />
              <span class="text-xs font-bold text-amber-400 uppercase tracking-widest truncate">{{ group.title }}</span>
            </div>
            <span class="text-[10px] font-mono text-amber-500/60 shrink-0">
              {{ i18n.t('project.milestoneIssues', { count: group.issues.length }) }}
            </span>
          </button>

          <!-- Issues within milestone -->
          @if (isMilestoneExpanded(group.id)) {
            @for (issue of group.issues; track issue.id) {
              <div
                class="bg-black/30 rounded-xl p-3 mb-2 ml-2 border-l-2 transition-all hover:bg-black/40 cursor-pointer"
                [class]="issueBorderClass(issue.priority)"
                (click)="openIssueDetail(issue)"
              >
                <div class="flex items-center justify-between mb-1">
                  <span class="text-[10px] uppercase tracking-widest font-bold"
                    [class]="issuePriorityColor(issue.priority)"
                  >
                    {{ issue.priority }}
                  </span>
                  <span class="text-[9px] font-mono text-slate-600 uppercase">{{ issue.status }}</span>
                </div>
                <p class="text-sm text-slate-300 mb-2">{{ issue.title }}</p>
                <div class="progress-dots">
                  @for (step of issueSteps; track step; let i = $index) {
                    <span
                      class="dot"
                      [class.done]="getStepIndex(issue.status) > i"
                      [class.active]="getStepIndex(issue.status) === i"
                    ></span>
                  }
                </div>
                @if (issue.subIssues && issue.subIssues.length > 0) {
                  <span class="text-[10px] mt-1 block"
                    [class]="getSubIssueDoneCount(issue.subIssues) === issue.subIssues.length ? 'text-emerald-500/60' : 'text-slate-600'">
                    {{ getSubIssueDoneCount(issue.subIssues) }}/{{ issue.subIssues.length }} {{ 'project.subIssuesTasks' | translate }}
                  </span>
                }
              </div>
            }
          }
        }
      } @else if (issues().length > 0) {
        <!-- Fallback: no milestones, show flat list -->
        @for (issue of issues(); track issue.id) {
          <div
            class="bg-black/30 rounded-xl p-3 mb-2 border-l-2 transition-all hover:bg-black/40 cursor-pointer"
            [class]="issueBorderClass(issue.priority)"
            (click)="openIssueDetail(issue)"
          >
            <div class="flex items-center justify-between mb-1">
              <span class="text-[10px] uppercase tracking-widest font-bold"
                [class]="issuePriorityColor(issue.priority)"
              >
                {{ issue.priority }}
              </span>
              <span class="text-[9px] font-mono text-slate-600 uppercase">{{ issue.status }}</span>
            </div>
            <p class="text-sm text-slate-300 mb-2">{{ issue.title }}</p>
            <div class="progress-dots">
              @for (step of issueSteps; track step; let i = $index) {
                <span
                  class="dot"
                  [class.done]="getStepIndex(issue.status) > i"
                  [class.active]="getStepIndex(issue.status) === i"
                ></span>
              }
            </div>
            @if (issue.subIssues && issue.subIssues.length > 0) {
              <span class="text-[10px] mt-1 block"
                [class]="getSubIssueDoneCount(issue.subIssues) === issue.subIssues.length ? 'text-emerald-500/60' : 'text-slate-600'">
                {{ getSubIssueDoneCount(issue.subIssues) }}/{{ issue.subIssues.length }} {{ 'project.subIssuesTasks' | translate }}
              </span>
            }
          </div>
        }
      } @else {
        <p class="text-slate-600 text-sm text-center py-8">{{ 'project.noIssues' | translate }}</p>
      }
    </div>

    <!-- Issue Detail Slide-Over -->
    @if (selectedIssue(); as si) {
      <div class="fixed inset-0 z-50 flex justify-end" (click)="closeIssueDetail()">
        <div class="absolute inset-0 bg-black/60 backdrop-blur-sm"></div>
        <div
          class="relative w-full max-w-lg bg-slate-900/95 border-l border-white/10 shadow-2xl overflow-y-auto animate-slide-in-right"
          (click)="$event.stopPropagation()"
        >
          <!-- Header -->
          <div class="sticky top-0 z-10 bg-slate-900/95 border-b border-white/5 px-6 py-4">
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-3">
                <span class="text-[10px] uppercase tracking-widest font-bold"
                  [class]="issuePriorityColor(si.priority)">
                  {{ si.priority }}
                </span>
                @if (si.gitlabIid) {
                  <span class="text-xs font-mono text-slate-500">#{{ si.gitlabIid }}</span>
                }
                <span class="text-[9px] font-mono text-slate-600 uppercase px-2 py-0.5 rounded-full border border-white/5">
                  {{ si.status }}
                </span>
              </div>
              <button (click)="closeIssueDetail()" class="text-slate-500 hover:text-white transition-colors">
                <app-icon name="x" [size]="18" />
              </button>
            </div>
            <h2 class="text-lg font-bold text-white mt-2">{{ si.title }}</h2>
          </div>

          <div class="px-6 py-4 space-y-6">
            <!-- Description -->
            @if (si.description) {
              <div>
                <h3 class="text-xs font-bold text-slate-500 uppercase tracking-widest mb-2">{{ 'project.issueDetail' | translate }}</h3>
                <p class="text-sm text-slate-300 whitespace-pre-wrap">{{ si.description }}</p>
              </div>
            }

            <!-- Sub-Issues -->
            @if (si.subIssues && si.subIssues.length > 0) {
              <div>
                <div class="flex items-center justify-between mb-2">
                  <h3 class="text-xs font-bold text-slate-500 uppercase tracking-widest">
                    {{ i18n.t('project.subIssues', { count: si.subIssues.length }) }}
                  </h3>
                  <span class="text-[10px] font-mono text-slate-600">
                    {{ getSubIssueDoneCount(si.subIssues) }}/{{ si.subIssues.length }} {{ 'project.subIssuesPassed' | translate }}
                  </span>
                </div>
                <div class="space-y-1.5">
                  @for (sub of si.subIssues; track sub.id) {
                    <div class="flex items-center gap-2.5 text-sm"
                      [class]="sub.status === 'DONE' || sub.status === 'CLOSED' ? 'text-emerald-400' : sub.status === 'NEEDS_REVIEW' ? 'text-red-400' : 'text-slate-400'">
                      <span class="w-2 h-2 rounded-full flex-shrink-0"
                        [class]="sub.status === 'DONE' || sub.status === 'CLOSED' ? 'bg-emerald-400' :
                                 sub.status === 'NEEDS_REVIEW' ? 'bg-red-400' :
                                 sub.status === 'IN_PROGRESS' || sub.status === 'TESTING' ? 'bg-amber-400' : 'bg-slate-600'"
                      ></span>
                      <span class="flex-1">{{ sub.title }}</span>
                      @if (sub.status === 'DONE' || sub.status === 'CLOSED') {
                        <span class="text-[10px] text-emerald-500/70">&#10003;</span>
                      } @else if (sub.status === 'NEEDS_REVIEW') {
                        <span class="text-[10px] text-red-500/70">&#10007;</span>
                      }
                    </div>
                  }
                </div>
              </div>
            }

            <!-- Labels -->
            @if (si.labels && si.labels.length > 0) {
              <div class="flex flex-wrap gap-1">
                @for (label of si.labels; track label) {
                  <span class="text-[10px] px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/20">
                    {{ label }}
                  </span>
                }
              </div>
            }

            <!-- Progress -->
            <div class="progress-dots">
              @for (step of issueSteps; track step; let i = $index) {
                <span
                  class="dot"
                  [class.done]="getStepIndex(si.status) > i"
                  [class.active]="getStepIndex(si.status) === i"
                ></span>
              }
            </div>

            <!-- Comments Timeline -->
            <div>
              <h3 class="text-xs font-bold text-slate-500 uppercase tracking-widest mb-3">
                {{ 'project.comments' | translate }}
              </h3>

              @if (selectedIssueComments().length > 0) {
                <div class="space-y-3">
                  @for (comment of selectedIssueComments(); track comment.id) {
                    <div class="rounded-xl p-3 border"
                      [class]="comment.authorType === 'AGENT' ? 'bg-indigo-500/5 border-indigo-500/20' : comment.authorType === 'USER' ? 'bg-emerald-500/5 border-emerald-500/20' : 'bg-amber-500/5 border-amber-500/20'"
                    >
                      <div class="flex items-center justify-between mb-1">
                        <span class="text-[10px] font-bold uppercase tracking-widest"
                          [class]="comment.authorType === 'AGENT' ? 'text-indigo-400' : comment.authorType === 'USER' ? 'text-emerald-400' : 'text-amber-400'"
                        >
                          {{ comment.authorName }}
                        </span>
                        <span class="text-[9px] font-mono text-slate-600">{{ formatTime(comment.createdAt) }}</span>
                      </div>
                      <p class="text-sm text-slate-300 whitespace-pre-wrap">{{ comment.content }}</p>
                    </div>
                  }
                </div>
              } @else {
                <p class="text-sm text-slate-600 text-center py-4">{{ 'project.noComments' | translate }}</p>
              }

              <!-- Comment Input -->
              <div class="mt-4 flex gap-2">
                <input
                  type="text"
                  [(ngModel)]="commentInput"
                  [placeholder]="'project.addComment' | translate"
                  class="flex-1 bg-black/40 rounded-xl px-4 py-2.5 text-sm text-white border border-white/5 outline-none focus:border-indigo-500/50 transition-colors"
                  (keydown.enter)="postComment()"
                />
                <button
                  (click)="postComment()"
                  [disabled]="!commentInput.trim() || commentSyncing()"
                  class="px-4 py-2.5 rounded-xl text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {{ 'common.send' | translate }}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    }
  `,
})
export class IssueBoardComponent {
  private api = inject(ApiService);
  i18n = inject(TranslateService);

  /** All issues */
  issues = input.required<Issue[]>();

  /** Issues grouped by milestone */
  issuesByMilestone = input.required<MilestoneGroup[]>();

  // ---- Internal state ----

  issueSteps = ISSUE_STEPS;
  expandedMilestones = signal<Set<string>>(new Set());
  selectedIssue = signal<Issue | null>(null);
  selectedIssueComments = signal<IssueComment[]>([]);
  commentInput = '';
  commentSyncing = signal(false);

  /** Initialize expanded milestones from input */
  setExpandedMilestones(ids: Set<string>) {
    this.expandedMilestones.set(ids);
  }

  toggleMilestone(id: string) {
    this.expandedMilestones.update(set => {
      const next = new Set(set);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  isMilestoneExpanded(id: string): boolean {
    return this.expandedMilestones().has(id);
  }

  openIssueDetail(issue: Issue) {
    this.selectedIssue.set(issue);
    this.selectedIssueComments.set([]);
    this.commentInput = '';

    this.api.getIssue(issue.id).subscribe((full) => {
      this.selectedIssue.set(full);
    });

    this.api.getIssueComments(issue.id).subscribe((comments) => {
      this.selectedIssueComments.set(comments);
    });
  }

  closeIssueDetail() {
    this.selectedIssue.set(null);
    this.selectedIssueComments.set([]);
    this.commentInput = '';
  }

  postComment() {
    const issue = this.selectedIssue();
    const content = this.commentInput.trim();
    if (!issue || !content) return;

    this.commentSyncing.set(true);

    this.api.addIssueComment(issue.id, {
      content,
      syncToGitlab: true,
    }).subscribe({
      next: (comment) => {
        this.selectedIssueComments.update((c) => [...c, comment]);
        this.commentInput = '';
        this.commentSyncing.set(false);
      },
      error: () => {
        this.commentSyncing.set(false);
      },
    });
  }

  getStepIndex(status: string): number {
    return ISSUE_STEPS.indexOf(status);
  }

  getSubIssueDoneCount(subIssues: { status: string }[]): number {
    return subIssues.filter(s => s.status === 'DONE' || s.status === 'CLOSED').length;
  }

  issueBorderClass(priority: string): string {
    switch (priority) {
      case 'CRITICAL': return 'border-l-rose-500';
      case 'HIGH': return 'border-l-amber-500';
      case 'MEDIUM': return 'border-l-yellow-500';
      case 'LOW': return 'border-l-emerald-500';
      default: return 'border-l-slate-700';
    }
  }

  issuePriorityColor(priority: string): string {
    switch (priority) {
      case 'CRITICAL': return 'text-rose-400';
      case 'HIGH': return 'text-amber-400';
      case 'MEDIUM': return 'text-yellow-400';
      case 'LOW': return 'text-emerald-400';
      default: return 'text-slate-400';
    }
  }

  formatTime(dateStr: string): string {
    return new Date(dateStr).toLocaleTimeString(this.i18n.dateLocale, {
      hour: '2-digit',
      minute: '2-digit',
    });
  }
}
