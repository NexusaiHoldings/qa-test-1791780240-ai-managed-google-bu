import type { GbpCtaType, GbpPhotoCategory, GbpSeason, GbpTrade } from "@/lib/gbp/templates";

export interface TemplateSeedDefinition {
  name: string;
  trade: GbpTrade;
  season: GbpSeason;
  bodyTemplate: string;
  requiredServiceTerm: boolean;
  requiredServiceCity: boolean;
  requiredPhotoCategory: boolean;
  requiredCtaType: boolean;
  isActive: boolean;
}

export interface KeywordSeedDefinition {
  trade: GbpTrade;
  season: GbpSeason;
  contractorTerm: string;
  customerTerm: string;
  isActive: boolean;
}

const TRADES: GbpTrade[] = ["plumbing", "electrical", "hvac", "multi-trade"];
const SEASONS: GbpSeason[] = ["cooling", "heating", "shoulder", "storm-freeze"];
const CTA_TYPES: GbpCtaType[] = ["call-now", "book-online", "request-quote", "learn-more"];
const PHOTO_CATEGORIES: GbpPhotoCategory[] = ["team", "jobsite", "before-after", "equipment", "finished-work"];

function titleCase(value: string): string {
  return value
    .replace(/-/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((part: string) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function makeTemplateBody(trade: GbpTrade, season: GbpSeason, variant: number): string {
  const intro = [
    `Serving {{service_city}} with reliable {{service_term}} support this ${season} season.`,
    `Homeowners in {{service_city}} count on us for {{service_term}} when ${season} conditions hit.`,
    `If you're in {{service_city}} and need {{service_term}}, our crew is ready this ${season}.`,
  ][variant % 3];

  const detail = [
    `Our ${trade === "hvac" ? "comfort-focused" : "local"} technicians bring the right tools and clear communication.`,
    `We handle diagnosis, repair, and preventative service so your system stays dependable.`,
    `Every visit includes straightforward options and workmanship backed by our team.`,
  ][variant % 3];

  return `${intro}\n\n${detail}\n\nPhoto idea: {{photo_category}}.\nAction: {{cta_type}}.`;
}

function makeTemplateName(trade: GbpTrade, season: GbpSeason, variant: number): string {
  return `${titleCase(trade)} ${titleCase(season)} Template ${variant + 1}`;
}

function contractorTermsByTrade(trade: GbpTrade): string[] {
  if (trade === "plumbing") {
    return [
      "water heater maintenance",
      "drain cleaning",
      "pipe leak repair",
      "sewer line inspection",
      "toilet repair",
      "faucet replacement",
      "sump pump service",
      "emergency plumbing repair",
      "backflow testing",
      "garbage disposal repair",
    ];
  }
  if (trade === "electrical") {
    return [
      "electrical panel upgrade",
      "circuit troubleshooting",
      "outlet replacement",
      "whole-home surge protection",
      "generator transfer switch install",
      "lighting retrofit",
      "ceiling fan installation",
      "wiring repair",
      "EV charger install",
      "smoke detector wiring",
    ];
  }
  if (trade === "hvac") {
    return [
      "air conditioner tune-up",
      "furnace maintenance",
      "boiler service",
      "heat pump repair",
      "duct cleaning",
      "thermostat replacement",
      "indoor air quality service",
      "AC repair",
      "heating system repair",
      "HVAC maintenance plan",
    ];
  }
  return [
    "seasonal home service",
    "preventative maintenance",
    "same-day service call",
    "home comfort inspection",
    "safety system check",
    "emergency home repair",
    "system performance tune-up",
    "energy efficiency service",
    "residential service visit",
    "trusted local technician",
  ];
}

function customerTermsByContractorTerm(term: string): string[] {
  return [
    term.replace("HVAC", "AC or heating"),
    term.replace("air conditioner", "AC"),
    term.replace("furnace", "heating system"),
    term.replace("boiler", "boiler service"),
    `${term} near me`,
    `${term} in my area`,
    `fix ${term.split(" ")[0]} issue`,
    `help with ${term}`,
    `local ${term}`,
    `same day ${term}`,
  ];
}

export function buildTemplateSeeds(): TemplateSeedDefinition[] {
  const templates: TemplateSeedDefinition[] = [];
  let variantCounter = 0;
  for (const trade of TRADES) {
    for (const season of SEASONS) {
      for (let i = 0; i < 4; i += 1) {
        templates.push({
          name: makeTemplateName(trade, season, i),
          trade,
          season,
          bodyTemplate: makeTemplateBody(trade, season, variantCounter),
          requiredServiceTerm: true,
          requiredServiceCity: true,
          requiredPhotoCategory: true,
          requiredCtaType: true,
          isActive: true,
        });
        variantCounter += 1;
      }
    }
  }
  return templates;
}

export function buildKeywordSeeds(): KeywordSeedDefinition[] {
  const seeds: KeywordSeedDefinition[] = [];
  for (const trade of TRADES) {
    for (const season of SEASONS) {
      for (const contractorTerm of contractorTermsByTrade(trade)) {
        const customerCandidates = customerTermsByContractorTerm(contractorTerm).slice(0, 2);
        for (const customerTerm of customerCandidates) {
          seeds.push({
            trade,
            season,
            contractorTerm,
            customerTerm,
            isActive: true,
          });
        }
      }
    }
  }
  return seeds;
}

export const TEMPLATE_SLOT_EXAMPLE = {
  serviceTerm: "AC repair",
  serviceCity: "Springfield",
  photoCategory: PHOTO_CATEGORIES[0],
  ctaType: CTA_TYPES[0],
};
