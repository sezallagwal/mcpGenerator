export interface MethodSignature {
  name: string;
  isOptional: boolean;
  parameters: ParamInfo[];
  returnType: string;
  jsDoc?: string;
}

export interface ParamInfo {
  name: string;
  type: string;
  isOptional: boolean;
}

export interface AppCapability {
  interfaceName: string;
  category: string;
  methods: MethodSignature[];
  jsDoc?: string;
  deprecated: boolean;
  importPath: string;
}

export interface CompactCapability {
  interfaceName: string;
  category: string;
  summary: string;
  methodNames: string[];
  deprecated: boolean;
}
