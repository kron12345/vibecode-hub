import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../environments/environment';

export interface Project {
  id: string;
  name: string;
  slug: string;
  description?: string;
  gitlabProjectId?: number;
  gitlabUrl?: string;
  createdAt: string;
  updatedAt: string;
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);
  private baseUrl = environment.apiUrl;

  getProjects() {
    return this.http.get<Project[]>(`${this.baseUrl}/projects`);
  }

  getProject(slug: string) {
    return this.http.get<Project>(`${this.baseUrl}/projects/${slug}`);
  }

  createProject(data: Partial<Project>) {
    return this.http.post<Project>(`${this.baseUrl}/projects`, data);
  }

  deleteProject(id: string) {
    return this.http.delete(`${this.baseUrl}/projects/${id}`);
  }
}
