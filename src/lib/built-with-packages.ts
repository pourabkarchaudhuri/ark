/**
 * What the About page lists under "Built with" (1.0.97 B37). The installed version of each npm
 * package is read at build time by `config/built-with.ts` (vite `define`), so it is never typed by
 * hand. LiteLLM and llama.cpp are not npm packages: their pinned versions come from the manifests.
 * Shared by the renderer and the build configs (listed in tsconfig.node.json), so keep it free of
 * renderer-only imports.
 */
export interface BuiltWithPackage {
  name: string;
  /** npm package whose installed version is shown; `litellm` and `llama.cpp` are read from their manifests. */
  pkg: string;
  url: string;
}

export const BUILT_WITH_PACKAGES: readonly BuiltWithPackage[] = [
  { name: 'Electron', pkg: 'electron', url: 'https://www.electronjs.org/' },
  { name: 'React', pkg: 'react', url: 'https://react.dev/' },
  { name: 'Vite', pkg: 'vite', url: 'https://vite.dev/' },
  { name: 'TypeScript', pkg: 'typescript', url: 'https://www.typescriptlang.org/' },
  { name: 'Tailwind CSS', pkg: 'tailwindcss', url: 'https://tailwindcss.com/' },
  { name: 'Framer Motion', pkg: 'framer-motion', url: 'https://www.framer.com/motion/' },
  { name: 'Three.js', pkg: 'three', url: 'https://threejs.org/' },
  { name: 'React Three Fiber', pkg: '@react-three/fiber', url: 'https://r3f.docs.pmnd.rs/' },
  { name: 'LangChain.js', pkg: 'langchain', url: 'https://js.langchain.com/' },
  { name: 'React Flow', pkg: '@xyflow/react', url: 'https://reactflow.dev/' },
  { name: 'ONNX Runtime', pkg: 'onnxruntime-node', url: 'https://onnxruntime.ai/' },
  { name: 'uSearch', pkg: 'usearch', url: 'https://github.com/unum-cloud/usearch' },
  { name: 'Radix UI', pkg: '@radix-ui/react-dialog', url: 'https://www.radix-ui.com/' },
  { name: 'Recharts', pkg: 'recharts', url: 'https://recharts.org/' },
  { name: 'Lucide', pkg: 'lucide-react', url: 'https://lucide.dev/' },
  { name: 'LiteLLM', pkg: 'litellm', url: 'https://docs.litellm.ai/' },
  { name: 'llama.cpp', pkg: 'llama.cpp', url: 'https://github.com/ggml-org/llama.cpp' },
  { name: 'Vitest', pkg: 'vitest', url: 'https://vitest.dev/' },
  { name: 'Playwright', pkg: 'playwright', url: 'https://playwright.dev/' },
];

/** `v1.2.3` for a known version, empty for a package the build could not read. */
export function formatBuiltWithVersion(versions: Record<string, string> | undefined, pkg: string): string {
  const v = versions?.[pkg];
  return v ? (/^[0-9]/.test(v) ? `v${v}` : v) : '';
}
