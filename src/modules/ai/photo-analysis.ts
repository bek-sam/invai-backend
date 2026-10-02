import type { DesignPhotoAnalysis } from "@invai/contracts";

export type AnalyzeDesignForPhotosInput = {
  designId: string;
  /** `designs.previewKey`: the small preview, never the print file. */
  previewKey: string | null;
  /** From imaging `/photo/palette` (T-26-4). */
  palette: {
    colors: { hex: string; share: number }[];
    lightShare: number;
    darkShare: number;
    transparentShare: number;
  };
  designName: string;
  tags: string[];
};

/**
 * Design analysis for listing photos (T-26-3, ADR 0023). Runs inside a job on the `ai` queue;
 * holds no transaction across the model call. Stub until the vision route lands.
 */
export async function analyzeDesignForPhotos(
  _companyId: string,
  _userId: string | null,
  _input: AnalyzeDesignForPhotosInput,
): Promise<DesignPhotoAnalysis> {
  throw new Error("analyzeDesignForPhotos: not implemented yet (T-26-3)");
}
