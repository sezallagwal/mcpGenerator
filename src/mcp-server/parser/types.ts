import type { OpenAPIV3 } from "openapi-types";
import type { JSONSchema7 } from "json-schema";

export type Domain =
  | "authentication"
  | "messaging"
  | "rooms"
  | "user-management"
  | "omnichannel"
  | "integrations"
  | "settings"
  | "statistics"
  | "notifications"
  | "content-management"
  | "marketplace-apps"
  | "miscellaneous";

export const VALID_DOMAINS: Domain[] = [
  "authentication",
  "messaging",
  "rooms",
  "user-management",
  "omnichannel",
  "integrations",
  "settings",
  "statistics",
  "notifications",
  "content-management",
  "marketplace-apps",
  "miscellaneous",
];

export interface CompactEndpoint {
  operationId: string;
  method: string;
  path: string;
  summary: string;
  domain: Domain;
  tag: string;
  bodyFields?: string;
}

export interface FullEndpoint {
  operationId: string;
  method: string;
  path: string;
  summary: string;
  description: string;
  domain: Domain;
  parameters: OpenAPIV3.ParameterObject[];
  requestBody?: {
    contentType: string;
    schema: JSONSchema7;
    required: boolean;
  };
  responseSchema?: JSONSchema7;
  security: OpenAPIV3.SecurityRequirementObject[];
  inputSchema: JSONSchema7;
}
