export type CompatPhase = "structure" | "semantics" | "media";

export type CompatChange = {
  id: string;
  phase: CompatPhase;
  count: number;
};
export type CompatReport = {
  changes: CompatChange[];
  appliedPasses: string[];
};

export type CompatPass = {
  id: string;
  phase: CompatPhase;
  apply(document: Document): number;
};
