import type { ListingDraft } from "@invai/contracts";
import type { TenantContext } from "../../api/context";
import type { Tx } from "../../db/client";

export type AttachPhotosInput = {
  draftId: string;
  imageKeys: string[];
  aiGenerated: boolean;
  syntheticPerformer: boolean;
};

/** Appends approved photo keys to a draft and records image disclosures (T-26-3). Stub. */
export async function attachPhotosToDraft(
  _tx: Tx,
  _ctx: TenantContext,
  _input: AttachPhotosInput,
): Promise<ListingDraft> {
  throw new Error("attachPhotosToDraft: not implemented yet (T-26-3)");
}
