declare module "bun:test" {
  export const expect: <T>(actual: T) => {
    toBe(expected: T): void;
    toContain(expected: string): void;
    not: {
      toContain(expected: string): void;
    };
  };
  export const test: (name: string, fn: () => void) => void;
}

interface ImportMeta {
  dir: string;
}
