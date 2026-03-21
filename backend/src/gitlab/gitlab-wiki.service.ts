/**
 * GitLab Wiki — Wiki page CRUD and search.
 */
import { firstValueFrom } from 'rxjs';
import { GitlabIssuesService } from './gitlab-issues.service';
import { GitLabWikiPage } from './gitlab.interfaces';

export class GitlabWikiService extends GitlabIssuesService {
  // ─── Wiki ─────────────────────────────────────────────────

  async listWikiPages(projectId: number): Promise<GitLabWikiPage[]> {
    const { data } = await firstValueFrom(
      this.httpService.get<GitLabWikiPage[]>(
        `${this.apiUrl}/projects/${projectId}/wikis`,
        { headers: this.headers },
      ),
    );
    return data;
  }

  async getWikiPage(projectId: number, slug: string): Promise<GitLabWikiPage> {
    const { data } = await firstValueFrom(
      this.httpService.get<GitLabWikiPage>(
        `${this.apiUrl}/projects/${projectId}/wikis/${encodeURIComponent(slug)}`,
        { headers: this.headers },
      ),
    );
    return data;
  }

  /**
   * Read a wiki page's content. Returns null if page doesn't exist (404).
   * This is the null-safe version of getWikiPage() — safe for fallback logic.
   */
  async getWikiPageContent(
    projectId: number,
    slug: string,
  ): Promise<string | null> {
    try {
      const page = await this.getWikiPage(projectId, slug);
      return page.content ?? null;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 404) return null;
      this.logger.warn(
        `Wiki read failed for "${slug}" in project ${projectId}: ${err.message}`,
      );
      return null;
    }
  }

  /**
   * List all wiki pages with their full content.
   * Uses with_content=1 parameter to fetch content in the list call.
   */
  async listWikiPagesWithContent(
    projectId: number,
  ): Promise<Array<{ slug: string; title: string; content: string }>> {
    try {
      const { data } = await firstValueFrom(
        this.httpService.get<GitLabWikiPage[]>(
          `${this.apiUrl}/projects/${projectId}/wikis`,
          {
            headers: this.headers,
            params: { with_content: 1 },
          },
        ),
      );
      return data.map((p) => ({
        slug: p.slug,
        title: p.title,
        content: p.content,
      }));
    } catch (err: any) {
      this.logger.warn(
        `Wiki list failed for project ${projectId}: ${err.message}`,
      );
      return [];
    }
  }

  async createWikiPage(
    projectId: number,
    title: string,
    content: string,
    format: 'markdown' | 'rdoc' | 'asciidoc' = 'markdown',
  ): Promise<GitLabWikiPage> {
    const { data } = await firstValueFrom(
      this.httpService.post<GitLabWikiPage>(
        `${this.apiUrl}/projects/${projectId}/wikis`,
        { title, content, format },
        { headers: this.headers },
      ),
    );
    this.logger.log(`Created wiki page "${title}" in project ${projectId}`);
    return data;
  }

  async updateWikiPage(
    projectId: number,
    slug: string,
    title: string,
    content: string,
  ): Promise<GitLabWikiPage> {
    const { data } = await firstValueFrom(
      this.httpService.put<GitLabWikiPage>(
        `${this.apiUrl}/projects/${projectId}/wikis/${encodeURIComponent(slug)}`,
        { title, content },
        { headers: this.headers },
      ),
    );
    this.logger.log(`Updated wiki page "${slug}" in project ${projectId}`);
    return data;
  }

  async deleteWikiPage(projectId: number, slug: string): Promise<void> {
    await firstValueFrom(
      this.httpService.delete(
        `${this.apiUrl}/projects/${projectId}/wikis/${encodeURIComponent(slug)}`,
        { headers: this.headers },
      ),
    );
    this.logger.log(`Deleted wiki page "${slug}" in project ${projectId}`);
  }

  /**
   * Create or update a wiki page. Tries create first;
   * on conflict (page exists), falls back to update.
   */
  async upsertWikiPage(
    projectId: number,
    title: string,
    content: string,
  ): Promise<GitLabWikiPage> {
    const slug = title.toLowerCase().replace(/\s+/g, '-');
    try {
      return await this.createWikiPage(projectId, title, content);
    } catch (err: any) {
      // 400 or 409 = page already exists → update
      const status = err?.response?.status ?? err?.status;
      if (status === 400 || status === 409) {
        return this.updateWikiPage(projectId, slug, title, content);
      }
      throw err;
    }
  }
}
