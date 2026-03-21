export const DEPLOYMENT_TYPES = [
  "construction",
  "commercial",
  "school",
  "sports",
  "estate",
  "residential",
] as const;

export type DeploymentType = (typeof DEPLOYMENT_TYPES)[number];

export function isDeploymentType(value: string): value is DeploymentType {
  return (DEPLOYMENT_TYPES as readonly string[]).includes(value);
}

