// The standalone validator scripts/generate.ts writes beside this file.
export declare const validate: {
  (data: unknown): boolean;
  errors?: { instancePath: string; message?: string }[] | null;
};
