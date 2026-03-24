import { Project, Node } from "ts-morph";
import { createRequire } from "node:module";
import { dirname, join, relative, sep } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import type {
  AppCapability,
  CompactCapability,
  MethodSignature,
  ParamInfo,
} from "./types.js";

let cachedCapabilities: AppCapability[] | null = null;

function resolveAppsEnginePath(): string {
  const require = createRequire(import.meta.url);
  const pkgJsonPath = require.resolve("@rocket.chat/apps-engine/package.json");
  return join(dirname(pkgJsonPath), "definition");
}

function extractAppInterfaceNames(project: Project, defPath: string): string[] {
  const filePath = join(defPath, "metadata", "AppInterface.d.ts");
  const sourceFile = project.addSourceFileAtPath(filePath);
  const enumDecl = sourceFile.getEnumOrThrow("AppInterface");

  return enumDecl.getMembers().map((m) => {
    const init = m.getInitializer();
    if (init) {
      return init.getText().replace(/['"]/g, "");
    }
    return m.getName();
  });
}

function extractAppMethodMap(
  project: Project,
  defPath: string,
): Map<string, string> {
  const filePath = join(defPath, "metadata", "AppMethod.d.ts");

  let sourceFile = project.getSourceFile(filePath);
  if (!sourceFile) {
    sourceFile = project.addSourceFileAtPath(filePath);
  }

  const enumDecl = sourceFile.getEnumOrThrow("AppMethod");
  const map = new Map<string, string>();

  for (const member of enumDecl.getMembers()) {
    const init = member.getInitializer();
    if (init) {
      const value = init.getText().replace(/['"]/g, "");
      map.set(`AppMethod.${member.getName()}`, value);
    }
  }

  return map;
}

function buildInterfaceFileMap(
  defPath: string,
  interfaceNames: string[],
): Map<string, { filePath: string; category: string }> {
  const map = new Map<string, { filePath: string; category: string }>();

  const categoryDirs = readdirSync(defPath, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const ifaceName of interfaceNames) {
    const fileName = `${ifaceName}.d.ts`;

    for (const category of categoryDirs) {
      const filePath = join(defPath, category, fileName);
      if (existsSync(filePath)) {
        map.set(ifaceName, { filePath, category });
        break;
      }
    }

    if (!map.has(ifaceName)) {
      let found = false;
      for (const category of categoryDirs) {
        const catDir = join(defPath, category);
        if (!existsSync(catDir)) continue;
        const files = readdirSync(catDir).filter((f) => f.endsWith(".d.ts"));
        for (const f of files) {
          const fPath = join(catDir, f);
          map.set(ifaceName, { filePath: fPath, category });
          found = true;
          break;
        }
        if (found) break;
      }
    }
  }

  return map;
}

function parseInterface(
  project: Project,
  interfaceName: string,
  filePath: string,
  category: string,
  appMethodMap: Map<string, string>,
  defPath: string,
): AppCapability | null {
  let sourceFile = project.getSourceFile(filePath);
  if (!sourceFile) {
    try {
      sourceFile = project.addSourceFileAtPath(filePath);
    } catch {
      return null;
    }
  }

  const iface = sourceFile.getInterface(interfaceName);
  if (!iface) {
    const categoryDir = join(defPath, category);
    if (existsSync(categoryDir)) {
      const dtsFiles = readdirSync(categoryDir).filter((f: string) =>
        f.endsWith(".d.ts"),
      );
      for (const f of dtsFiles) {
        const altPath = join(categoryDir, f);
        let altFile = project.getSourceFile(altPath);
        if (!altFile) {
          try {
            altFile = project.addSourceFileAtPath(altPath);
          } catch {
            continue;
          }
        }
        const altIface = altFile.getInterface(interfaceName);
        if (altIface) {
          return parseInterfaceNode(
            altIface,
            interfaceName,
            category,
            appMethodMap,
            altPath,
            defPath,
          );
        }
      }
    }
    return null;
  }

  return parseInterfaceNode(
    iface,
    interfaceName,
    category,
    appMethodMap,
    filePath,
    defPath,
  );
}

function parseInterfaceNode(
  iface: import("ts-morph").InterfaceDeclaration,
  interfaceName: string,
  category: string,
  appMethodMap: Map<string, string>,
  filePath: string,
  defPath: string,
): AppCapability {
  const methods: MethodSignature[] = [];

  for (const method of iface.getMethods()) {
    let methodName = method.getName();

    if (methodName.startsWith("[")) {
      const key = methodName.replace(/^\[|\]$/g, "").trim();
      const resolved = appMethodMap.get(key);
      if (resolved) {
        methodName = resolved;
      }
    }

    const parameters: ParamInfo[] = method.getParameters().map((p) => ({
      name: p.getName(),
      type: simplifyType(p.getType().getText(p)),
      isOptional: p.isOptional(),
    }));

    const returnType = simplifyType(method.getReturnType().getText(method));

    const jsDocs = method.getJsDocs();
    const jsDoc =
      jsDocs.length > 0 ? jsDocs[0].getDescription().trim() : undefined;

    methods.push({
      name: methodName,
      isOptional: method.hasQuestionToken(),
      parameters,
      returnType,
      jsDoc,
    });
  }

  const ifaceJsDocs = iface.getJsDocs();
  let jsDoc: string | undefined;
  let deprecated = false;

  if (ifaceJsDocs.length > 0) {
    jsDoc = ifaceJsDocs[0].getDescription().trim();
    const tags = ifaceJsDocs[0].getTags();
    deprecated = tags.some((t) => t.getTagName() === "deprecated");
  }

  const relPath = relative(dirname(defPath), filePath)
    .replace(/\.d\.ts$/, "")
    .split(sep)
    .join("/");

  return {
    interfaceName,
    category,
    methods,
    jsDoc,
    deprecated,
    importPath: relPath,
  };
}

function simplifyType(typeText: string): string {
  return typeText.replace(/import\([^)]*\)\./g, "");
}

export function parseAllCapabilities(): AppCapability[] {
  if (cachedCapabilities) return cachedCapabilities;

  const defPath = resolveAppsEnginePath();

  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      declaration: true,
      skipLibCheck: true,
    },
  });

  const interfaceNames = extractAppInterfaceNames(project, defPath);

  const appMethodMap = extractAppMethodMap(project, defPath);

  const fileMap = buildInterfaceFileMap(defPath, interfaceNames);

  const capabilities: AppCapability[] = [];

  for (const ifaceName of interfaceNames) {
    const fileInfo = fileMap.get(ifaceName);
    if (!fileInfo) continue;

    const cap = parseInterface(
      project,
      ifaceName,
      fileInfo.filePath,
      fileInfo.category,
      appMethodMap,
      defPath,
    );

    if (cap && cap.methods.length > 0) {
      capabilities.push(cap);
    }
  }

  cachedCapabilities = capabilities;
  return capabilities;
}

export function listCapabilities(): CompactCapability[] {
  const full = parseAllCapabilities();
  return full.map((cap) => ({
    interfaceName: cap.interfaceName,
    category: cap.category,
    summary:
      cap.jsDoc?.split("\n")[0] ?? `Handler for ${cap.interfaceName} events`,
    methodNames: cap.methods.map((m) => m.name),
    deprecated: cap.deprecated,
  }));
}

export function getCapabilities(interfaceNames: string[]): AppCapability[] {
  const all = parseAllCapabilities();
  const nameSet = new Set(interfaceNames);
  return all.filter((c) => nameSet.has(c.interfaceName));
}

export function getAvailableCategories(): string[] {
  const all = parseAllCapabilities();
  return [...new Set(all.map((c) => c.category))].sort();
}

export function getCapabilitiesByCategory(category: string): AppCapability[] {
  const all = parseAllCapabilities();
  return all.filter((c) => c.category === category);
}

export function clearCapabilityCache(): void {
  cachedCapabilities = null;
}
