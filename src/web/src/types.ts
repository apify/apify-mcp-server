// --- Global Augmentations ---

declare global {
    interface Window {
        openai?: Record<string, unknown>;
    }
}

// --- App Specific Types ---

export type PricingTier = string;

export type StructuredPricingInfo = {
    model: string;
    userTier?: PricingTier;
    pricePerUnit?: number;
    unitName?: string;
    trialMinutes?: number;
    tieredPricing?: {
        tier: PricingTier;
        pricePerUnit: number;
    }[];
    events?: {
        title: string;
        description?: string;
        priceUsd?: number;
        tieredPricing?: {
            tier: PricingTier;
            priceUsd: number;
        }[];
    }[];
    pricingNote?: string;
    eventDescriptionsOmitted?: boolean;
    eventDescriptionsNote?: string;
}

export interface ActorStats {
    totalUsers: number;
    actorReviewRating: number;
    actorReviewCount: number;
}

export interface ActorDetails {
  actorInfo: Actor;
  actorCard: string;
  readme: string;
  inputSchema?: {
    type: string;
    properties: Record<string, unknown>;
  };
}

export interface Actor {
  id: string;
  name: string;
  username: string;
  url: string;
  fullName?: string;
  title: string;
  description: string;
  pictureUrl?: string;
  stats?: ActorStats;
  currentPricingInfo?: StructuredPricingInfo;
}
