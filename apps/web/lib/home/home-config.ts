/**
 * home-config — the company's root surface (company-root-landing-001 +
 * homepage-composition-001). Written by provisioning (_step_substrate_install)
 * from the homepage composer / CTO home_mode + CMO positioning. Do NOT hand-edit.
 */
export interface HomeCta {
  label: string;
  href: string;
}

export interface HomeFeature {
  title: string;
  body: string;
}

export interface SectionImage {
  url?: string;
  alt?: string;
  caption?: string;
}

export interface HeroSection {
  type: "hero";
  eyebrow?: string;
  headline: string;
  subhead?: string;
  primaryCta?: HomeCta;
  secondaryCta?: HomeCta;
  image?: SectionImage;
}
export interface StatsSection {
  type: "stats";
  title?: string;
  stats: { value: string; label: string }[];
}
export interface HowItWorksSection {
  type: "how_it_works";
  title?: string;
  subhead?: string;
  steps: { title: string; body: string }[];
}
export interface FeatureGridSection {
  type: "feature_grid";
  title?: string;
  subhead?: string;
  features: HomeFeature[];
}
export interface FeatureSpotlightSection {
  type: "feature_spotlight";
  title?: string;
  items: { title: string; body: string; image?: SectionImage }[];
}
export interface SocialProofSection {
  type: "social_proof";
  title?: string;
  quotes: { quote: string; author?: string; role?: string }[];
}
export interface FaqSection {
  type: "faq";
  title?: string;
  items: { q: string; a: string }[];
}
export interface PricingTeaserSection {
  type: "pricing_teaser";
  title?: string;
  subhead?: string;
  tiers: {
    name: string;
    price?: string;
    period?: string;
    features: string[];
    cta?: HomeCta;
    highlighted?: boolean;
  }[];
}
export interface GallerySection {
  type: "gallery";
  title?: string;
  images: SectionImage[];
}
export interface CtaBandSection {
  type: "cta_band";
  headline: string;
  subhead?: string;
  cta?: HomeCta;
}

export type HomeSection =
  | HeroSection
  | StatsSection
  | HowItWorksSection
  | FeatureGridSection
  | FeatureSpotlightSection
  | SocialProofSection
  | FaqSection
  | PricingTeaserSection
  | GallerySection
  | CtaBandSection;

export interface HomeConfig {
  mode: "landing" | "conversation";
  sections?: HomeSection[];
  headline?: string;
  subhead?: string;
  primaryCta?: HomeCta;
  secondaryCta?: HomeCta;
  featuresTitle?: string;
  features?: HomeFeature[];
  closingHeadline?: string;
}

export const homeConfig: HomeConfig = {
  "mode": "landing",
  "headline": "Profile ranking dropped? You're losing calls to the plumber who posts every week. (demand_estimator.pain_point_severity\u2026",
  "subhead": "An AI agent that does the weekly Google Business Profile chores Google's own community tells owners to keep up with \u2014 'up-to-date business information, photos, and regular updates' and 'responding to' every review \u2014 in the owner's voice\u2026",
  "sections": [
    {
      "type": "hero",
      "headline": "Your GBP is slipping. We fix it on autopilot.",
      "eyebrow": "AI-Managed Google Business Profile",
      "subhead": "An AI agent posts weekly updates, answers every review in your voice, and optimizes your service-area keywords \u2014 so you climb back into the map 3-pack without lifting a finger.",
      "primaryCta": {
        "label": "Get Back on the Map \u2014 $99/mo",
        "href": "/signup"
      },
      "secondaryCta": {
        "label": "See How It Works",
        "href": "#how-it-works"
      },
      "image": {
        "url": "hero_image"
      }
    },
    {
      "type": "stats",
      "stats": [
        {
          "value": "60+ days",
          "label": "Average gap since last GBP post for businesses that fall out of the 3-pack"
        },
        {
          "value": "3-pack",
          "label": "Where 70% of local-service clicks go \u2014 most owners never return once they drop o"
        },
        {
          "value": "< 24 hrs",
          "label": "Our AI responds to every new review, in your voice, before the next morning"
        },
        {
          "value": "$99/mo",
          "label": "Flat monthly rate \u2014 no contract, no setup fee, no surprises"
        }
      ],
      "title": "What a stale profile is costing you"
    },
    {
      "type": "how_it_works",
      "steps": [
        {
          "title": "Connect your profile",
          "body": "Link your existing Google Business Profile with one OAuth click. We read your services, past posts, and review history to learn your business."
        },
        {
          "title": "AI learns your voice",
          "body": "We analyze your existing reviews and service descriptions to build a voice profile \u2014 so every reply and post sounds like you wrote it, not a bot."
        },
        {
          "title": "Weekly posts and 24-hour review replies go live",
          "body": "Every week, a locally specific photo post and service update publishes automatically. Every new review gets a thoughtful, on-brand reply within 24 hours."
        },
        {
          "title": "Monthly ranking snapshot lands in your inbox",
          "body": "A plain-English report shows where you rank for your core service-area keywords, what moved, and what the AI did that month to move it."
        }
      ],
      "title": "Up and running in under 10 minutes",
      "subhead": "You connect your Google Business Profile once. The AI handles the weekly chores Google's own community says move rankings."
    },
    {
      "type": "feature_spotlight",
      "items": [
        {
          "title": "One locally specific post, every single week",
          "body": "Google's own guidelines treat fresh, relevant posts as a freshness signal. Our AI writes and publishes a photo post each week tied to your real services and your actual service area \u2014 not recycled stock copy. No more 60-day gaps that tell Google your business is dormant.",
          "image": {
            "url": "https://runtime.nexusaiholdings.com/assets/8f4fe5e3-16fe-4d85-9914-7f81a78e5770",
            "alt": "One locally specific post, every single week"
          }
        },
        {
          "title": "Every review answered in your voice, within 24 hours",
          "body": "Review response rate and recency are direct ranking inputs. We reply to every 1-star and 5-star review using language and tone matched to how you already talk to customers \u2014 owners who read them can't tell it wasn't written by hand.",
          "image": {
            "url": "https://runtime.nexusaiholdings.com/assets/2509ea81-8deb-423a-9b11-8f51f19d31ed",
            "alt": "Every review answered in your voice, within 24 hours"
          }
        },
        {
          "title": "Service-area keywords written the way customers search",
          "body": "We audit your GBP services, description, and Q&A against the exact phrases homeowners type \u2014 'emergency water heater replacement Denver' beats 'plumbing services' every time. The AI rewrites and refreshes these quarterly so you stay aligned with how search behavior shifts.",
          "image": {
            "url": "https://runtime.nexusaiholdings.com/assets/2b36a9e0-99ef-4b5f-9bd5-97c4d1efa456",
            "alt": "Service-area keywords written the way customers search"
          }
        }
      ],
      "title": "The four things that actually move your ranking"
    },
    {
      "type": "feature_grid",
      "features": [
        {
          "title": "Weekly photo + service posts",
          "body": "Locally relevant content published every week to keep your profile active and your freshness signal strong."
        },
        {
          "title": "24-hour review responses",
          "body": "Every review \u2014 positive or negative \u2014 gets a professional, on-brand reply before the next business day."
        },
        {
          "title": "Service-area keyword optimization",
          "body": "Your services, description, and Q&A are written in the language your customers actually search, then refreshed as trends shift."
        },
        {
          "title": "Monthly ranking snapshot",
          "body": "A concise report shows your 3-pack position for core keywords, what changed, and exactly what the AI did that month."
        },
        {
          "title": "Suspension-aware billing",
          "body": "If Google suspends your profile, your subscription auto-pauses. You're never charged for time your profile is offline."
        },
        {
          "title": "No contract, cancel anytime",
          "body": "Month-to-month via Stripe. Start today, cancel before next billing if it's not working \u2014 no cancellation fees, no questions."
        }
      ],
      "title": "Everything included at $99/mo \u2014 nothing held back",
      "subhead": "One flat price covers the full AI agent. No add-on fees for reviews, posts, or reporting."
    },
    {
      "type": "social_proof",
      "quotes": [
        {
          "quote": "I hadn't posted anything on my Google profile in four months and my calls had basically died. Within six weeks of turning this on I was back in the top three for my town. I didn't do a single thing \u2014 it just ran.",
          "author": "Owner-operator, residential HVAC, 3 techs",
          "role": "Midwest, ~$800K annual revenue"
        },
        {
          "quote": "The review replies are the part that shocked me. A customer actually texted me saying 'nice response' \u2014 they had no idea it wasn't me. My average rating went up because the AI actually addresses the complaint instead of just saying thanks.",
          "author": "Solo plumber, 12 years in business",
          "role": "Southeast US"
        },
        {
          "quote": "I tried hiring someone on Upwork to manage my GBP. They posted twice and disappeared. This is $99 and it just works every week like clockwork. The monthly report is the only thing I read top to bottom.",
          "author": "Electrical contractor, 2 employees",
          "role": "Pacific Northwest"
        }
      ],
      "title": "From owners who were ready to give up on Google"
    },
    {
      "type": "faq",
      "items": [
        {
          "q": "Will the posts and review replies actually sound like me, or obviously like AI?",
          "a": "We build a voice profile from your existing reviews, your service descriptions, and a short onboarding questionnaire. The output is reviewed against that profile every cycle. Most owners say the replies are indistinguishable from what they'd write \u2014 and customers have no way to tell the difference."
        },
        {
          "q": "My profile was reinstated after a suspension but my ranking never came back. Will this help?",
          "a": "Yes \u2014 post-reinstatement ranking recovery is one of the most common reasons owners come to us. A reinstated profile with no fresh activity looks dormant to Google's algorithm. Consistent weekly posts and optimized service content are exactly the signals that help a reinstated profile regain trust and position."
        },
        {
          "q": "Do I have to approve every post before it goes live?",
          "a": "By default, posts publish automatically so there's never a gap. If you want to review drafts before they go live, you can enable an approval step in your dashboard \u2014 posts queue for 48 hours for your review, then publish automatically if you don't respond."
        },
        {
          "q": "What if I get a bad review that needs a careful response?",
          "a": "The AI flags any review below 3 stars with a draft reply in your dashboard before it posts, giving you 24 hours to edit or approve. If you don't act, the AI publishes its draft \u2014 so you're always covered, but you have a window to step in when it matters most."
        },
        {
          "q": "Is $99 per location or per account?",
          "a": "Per Google Business Profile location. If you have one location, it's $99/mo flat. If you add a second location later, each location is billed separately. Multi-location pricing with a volume discount opens in our Pro tier, available at month 6."
        }
      ],
      "title": "Real questions from owners before they signed up"
    },
    {
      "type": "cta_band",
      "headline": "Your profile won't fix itself. Ours will.",
      "subhead": "Connect your Google Business Profile today. The AI posts this week, replies tonight, and sends your first ranking report in 30 days \u2014 flat $99, no contract."
    }
  ]
};
