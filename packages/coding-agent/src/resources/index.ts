import { join } from "node:path";
import type { SkillVisibility } from "../config.js";
import { loadAgents, type AgentDefinition } from "./agents.js";
import { loadContextFiles, type ContextFile } from "./context-files.js";
import { loadPrompts, type PromptTemplate } from "./prompts.js";
import { loadSkills, setSkillModelInvocation, type Skill } from "./skills.js";

export type LoadedResources = {
  skills: Skill[];
  prompts: PromptTemplate[];
  contextFiles: ContextFile[];
  readOnlyRoots: string[];
  agents: AgentDefinition[];
  agentWarnings: string[];
};

export class ResourceLoader {
  private loaded: LoadedResources | undefined;

  constructor(
    private readonly cwd: string,
    private readonly home: string,
    private skillOverrides: Record<string, SkillVisibility> = {},
    private trustProject = false,
  ) {}

  async load(): Promise<LoadedResources> {
    // Scanning skill roots walks the filesystem; reuse the last result until
    // reload()/setSkillOverrides() invalidates it (every LLM turn calls load).
    if (this.loaded) return this.loaded;
    const [contextFiles, skillResult, prompts, agentResult] = await Promise.all([
      loadContextFiles(this.cwd, this.home),
      loadSkills(this.cwd, this.home, this.skillOverrides, this.trustProject),
      loadPrompts(this.cwd, this.home, this.trustProject),
      loadAgents(this.cwd, this.home, this.trustProject),
    ]);
    const roots = [
      join(this.home, "skills"),
      join(this.home, "prompts"),
      ...(this.trustProject
        ? [join(this.cwd, ".cletus", "skills"), join(this.cwd, ".cletus", "prompts")]
        : []),
      ...skillResult.roots,
    ];
    const result: LoadedResources = {
      skills: skillResult.skills,
      prompts,
      contextFiles,
      readOnlyRoots: [...new Set(roots)],
      agents: agentResult.agents,
      agentWarnings: agentResult.warnings,
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

  setSkillOverrides(overrides: Record<string, SkillVisibility>): void {
    this.skillOverrides = { ...overrides };
    this.reload();
  }

  async setSkillDisabled(name: string, disabled: boolean): Promise<Skill> {
    const loaded = this.loaded ?? (await this.load());
    const skill = loaded.skills.find((candidate) => candidate.name === name);
    if (!skill) throw new Error(`Skill not found: ${name}`);
    await setSkillModelInvocation(skill.path, disabled);
    this.reload();
    return skill;
  }
}

export type { AgentDefinition, ContextFile, PromptTemplate, Skill };
export { builtinAgents, CORE_TOOL_NAMES, loadAgents } from "./agents.js";