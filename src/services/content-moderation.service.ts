/** Local, deliberately narrow marketplace content policy. No user text is executed or sent to AI. */
export const CONTENT_POLICY_VERSION = "2026-09-30.1";

export type ContentKind = "SERVICE_LISTING" | "SERVICE_REQUEST";
export type ContentDecision = {
  outcome: "PASS" | "REVISE";
  reasonCode: "CLEAR" | "PROFANITY" | "HATE_SPEECH" | "PROHIBITED_SERVICE" | "HIGH_RISK" | "CATEGORY_MISMATCH";
  message: string;
  policyVersion: string;
  field?: "title" | "description" | "category";
};

type ContentInput = { kind: ContentKind; categoryName: string; title: string; description: string };

// Do not use broad substrings: terms such as "ass" occur inside ordinary trade words.
const explicitProfanity = ["fuck", "fucking", "motherfucker", "putang ina", "tangina"];
// Exact tokens only, plus the same token repeated without separators. Never
// match arbitrary substrings of ordinary words.
const explicitHateTerms = ["nigger", "nigga"];
const prohibitedPhrases = [
  "sell illegal drugs",
  "buy illegal drugs",
  "sell stolen goods",
  "buy stolen goods",
  "forge government id",
  "fake government id",
  "hack someone account",
  "hack someone s account",
  "sell firearms",
  "buy firearms",
  "sell prescription drugs",
  "magbenta ng droga",
  "benta ng droga",
  "baligya og droga",
];
const highRiskPhrases = ["private security service", "medical treatment service"];

// Strong cross-category cues are advisory, not a semantic classifier. Admin-managed
// categories outside this map receive no guessed vocabulary or invented label.
const categoryCues: Record<string, string[]> = {
  plumbing: ["plumb", "pipe", "faucet", "leak", "toilet", "drain"],
  "electrical repair": ["electrical", "electrician", "wiring", "outlet", "circuit"],
  "house cleaning": ["clean", "mop", "sweep", "laundry"],
  "lawn care": ["lawn", "grass", "garden", "mow"],
  tutoring: ["tutor", "teach", "lesson", "calculus", "math", "study"],
  "aircon service": ["aircon", "air conditioner", "air conditioning", "ac unit"],
  "appliance repair": ["appliance", "refrigerator", "washing machine", "microwave"],
  "carpentry & woodwork": ["carpenter", "woodwork", "cabinet", "furniture"],
};

function normalize(value: string) {
  return value.normalize("NFKC")
    .toLocaleLowerCase("en-PH")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2060\ufeff]/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ").trim();
}

function deobfuscate(value: string) {
  const substitutions: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t" };
  return value.replace(/[013457]/g, (digit) => substitutions[digit]);
}

function containsPhrase(haystack: string, phrase: string) {
  return (` ${haystack} `).includes(` ${phrase} `);
}

function containsHateTerm(haystack: string) {
  return haystack.split(" ").some((word) => explicitHateTerms.some((term) =>
    word === term || (word.length >= term.length * 2 && word.length % term.length === 0 && word === term.repeat(word.length / term.length))));
}

function hasCue(text: string, cue: string) {
  const words = text.split(" ");
  return cue.includes(" ") ? containsPhrase(text, cue) : words.some((word) => word === cue || (cue.length >= 5 && word.startsWith(cue)));
}

function decision(outcome: ContentDecision["outcome"], reasonCode: ContentDecision["reasonCode"], message: string, field?: ContentDecision["field"]): ContentDecision {
  return { outcome, reasonCode, message, policyVersion: CONTENT_POLICY_VERSION, ...(field ? { field } : {}) };
}

function contentVariants(original: string) {
  const text = normalize(original);
  const symbolDeobfuscated = normalize(original.replace(/[!|]/g, "i").replace(/@/g, "a").replace(/\$/g, "s"));
  const punctuationCollapsed = normalize(original.replace(/\b(?:[a-zA-Z0-9][.\-*]){3,14}[a-zA-Z0-9]\b/g, (match) => match.replace(/[.\-*]/g, "")));
  const variants = [text, deobfuscate(text), symbolDeobfuscated, deobfuscate(symbolDeobfuscated), punctuationCollapsed, deobfuscate(punctuationCollapsed)];
  // Handle short letter-by-letter punctuation obfuscation without collapsing
  // ordinary multi-word descriptions into a false positive.
  const separatedLetters = original.match(/\b(?:[a-zA-Z0-9][.\-*\s]){3,14}[a-zA-Z0-9]\b/g) ?? [];
  for (const candidate of separatedLetters) variants.push(deobfuscate(normalize(candidate).replace(/\s/g, "")));
  return variants;
}

export function assessMarketplaceContent(input: ContentInput): ContentDecision {
  const original = `${input.title} ${input.description}`;
  const text = normalize(original);
  const variants = contentVariants(original);
  const titleVariants = contentVariants(input.title);
  const descriptionVariants = contentVariants(input.description);

  if (variants.some(containsHateTerm)) {
    const field = titleVariants.some(containsHateTerm) ? "title" : descriptionVariants.some(containsHateTerm) ? "description" : undefined;
    return decision("REVISE", "HATE_SPEECH", "Remove hateful or abusive language before publishing.", field);
  }

  if (variants.some((variant) => explicitProfanity.some((term) => containsPhrase(variant, term) || variant === term))) {
    const field = titleVariants.some((variant) => explicitProfanity.some((term) => containsPhrase(variant, term))) ? "title" : "description";
    return decision("REVISE", "PROFANITY", "Remove offensive language before publishing.", field);
  }
  if (variants.some((variant) => prohibitedPhrases.some((phrase) => containsPhrase(variant, phrase)))) {
    const field = titleVariants.some((variant) => prohibitedPhrases.some((phrase) => containsPhrase(variant, phrase))) ? "title" : descriptionVariants.some((variant) => prohibitedPhrases.some((phrase) => containsPhrase(variant, phrase))) ? "description" : undefined;
    return decision("REVISE", "PROHIBITED_SERVICE", "This content cannot be published on ServiceHub. Please revise your submission.", field);
  }
  if (input.kind === "SERVICE_LISTING" && variants.some((variant) => highRiskPhrases.some((phrase) => containsPhrase(variant, phrase)))) {
    return decision("REVISE", "HIGH_RISK", "ServiceHub does not support private security or medical treatment services. Offer a supported type of service.", "description");
  }

  const selected = normalize(input.categoryName);
  const selectedCues = categoryCues[selected];
  if (selectedCues && !selectedCues.some((cue) => hasCue(text, cue))) {
    const otherMatches = Object.entries(categoryCues)
      .filter(([name, cues]) => name !== selected && cues.some((cue) => hasCue(text, cue)));
    if (otherMatches.length === 1) {
      return decision("REVISE", "CATEGORY_MISMATCH", "Choose the category that matches the service you described before publishing.", "category");
    }
  }
  return decision("PASS", "CLEAR", "Content check passed.");
}

export function requirePublishableContent(input: ContentInput): ContentDecision {
  const result = assessMarketplaceContent(input);
  if (result.outcome === "REVISE") {
    throw Object.assign(new Error(result.message), { status: 422, code: "CONTENT_REVISION_REQUIRED" });
  }
  return result;
}
