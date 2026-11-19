import type { AgentTool } from "@cletus/agent";
import type { ContextFile, Skill } from "../resources/index.js";

export type SystemPromptInput = {
  cwd: string;
  tools: AgentTool[];
  contextFiles: ContextFile[];
  skills: Skill[];
  /** Replaces the default persona line (subagent role definitions). */
  persona?: string;
};

export function buildSystemPrompt(input: SystemPromptInput): string {
  const sections: string[] = [
    input.persona ??
      "You are cletus, a coding agent running in the user's terminal. Inspect files, run commands, and modify code to complete the user's task.",
  ];

  const toolLines = input.tools.map((tool) => {
    const snippet = tool.snippet ?? tool.description.split("\n")[0]?.slice(0, 120) ?? tool.name;
    return `- ${tool.name}: ${snippet}`;
  });
  if (toolLines.length > 0) {
    sections.push(`<tools>\n${toolLines.join("\n")}\n</tools>`);
  }

  sections.push(
    `<rules>
- Use read instead of cat/sed for file inspection.
- Use edit for targeted changes; batch changes to one file in one call.
- Show file paths clearly.
- Never claim a command succeeded without checking its output.
- Be concise.
</rules>`,
  );

  if (input.contextFiles.length > 0) {
    const files = input.contextFiles
      .map(
        (file) =>
          `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>`,
      )
      .join("\n");
    sections.push(`<project_context>\n${files}\n</project_context>`);
  }

  const visibleSkills = input.skills.filter((skill) => !skill.disableModelInvocation);
  if (visibleSkills.length > 0) {
    const lines = visibleSkills.map((skill) => {
      const description = skill.visibility === "name-only"
        ? ""
        : `: ${skill.description}${skill.whenToUse ? ` ${skill.whenToUse}` : ""}`;
      return `- ${skill.name}${description} (path: ${skill.path})`;
    });
    sections.push(`<skills>\n${lines.join("\n")}\n</skills>`);
  }

  sections.push(`<cwd>${input.cwd}</cwd>`);
  return `${sections.join("\n\n")}\n`;
}