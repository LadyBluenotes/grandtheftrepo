import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { boardProjectKey, type BoardProject } from "./boardScope";

/** Which project a per-project action on the board applies to, when it covers more than one. */
export function ProjectSelect({
  projects,
  value,
  onChange,
  className,
}: {
  readonly projects: ReadonlyArray<BoardProject>;
  readonly value: BoardProject | null;
  readonly onChange: (project: BoardProject) => void;
  readonly className?: string;
}) {
  return (
    <Select
      value={value === null ? null : boardProjectKey(value)}
      onValueChange={(key) => {
        const next = projects.find((project) => boardProjectKey(project) === key);
        if (next !== undefined) onChange(next);
      }}
    >
      <SelectTrigger size="sm" className={className} aria-label="Project">
        <SelectValue placeholder="Pick a project">{value?.label}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {projects.map((project) => (
          <SelectItem key={boardProjectKey(project)} value={boardProjectKey(project)}>
            {project.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
