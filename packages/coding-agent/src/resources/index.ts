import { join } from "node:path";
import { loadContextFiles, type ContextFile } from "./context-files.js";
import { loadPrompts, type PromptTemplate } from "./prompts.js";
import { loadSkills, type Skill } from "./skills.js";

export type LoadedResources = {
  skills: Skill[];
  prompts: PromptTemplate[];
  contextFiles: ContextFile[];
  readOnlyRoots: string[];
};

export class ResourceLoader {
  private loaded: LoadedResources | undefined;

  constructor(
    private readonly cwd: string,
    private readonly home: string,
  ) {}

  async load(): Promise<LoadedResources> {
    const [contextFiles, skillResult, prompts] = await Promise.all([
      loadContextFiles(this.cwd, this.home),
      loadSkills(this.cwd, this.home),
      loadPrompts(this.cwd, this.home),
    ]);
    const roots = [
      join(this.home, "skills"),
      join(this.home, "prompts"),
      join(this.cwd, ".cletus", "skills"),
      join(this.cwd, ".cletus", "prompts"),
      ...skillResult.roots,
    ];
    const result: LoadedResources = {
      skills: skillResult.skills,
      prompts,
      contextFiles,
      readOnlyRoots: [...new Set(roots)],
    };
    this.loaded = result;
    return result;
  }

  get cached(): LoadedResources | undefined {
    return this.loaded;
  }

  reload(): void {
    this.loaded = undefined;
  }
}

export type { ContextFile, PromptTemplate, Skill };