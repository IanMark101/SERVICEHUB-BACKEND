import { isFallbackCategory, officialCategoryForName } from './category-catalog';

type Category = { id: string; name: string };
const genericWords = new Set('a an and are as at be by can do for from help i in is it me my need needs not of offer on or our please provide repair repairs service services some someone that the this to want we with work you your fix fixing broken'.split(' '));

function keywords(text: string) {
  const words = text.normalize('NFKC').toLocaleLowerCase('en-PH').match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  return new Set(words.map(word => word === 'pc' || word === 'pcs' ? 'computer' : word.length > 4 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word).filter(word => !genericWords.has(word)));
}

/** Conservative catalog matching is a fallback, never an AI-generated category. */
export function categoryMatchesFromText(input: { title: string; description: string }, categories: readonly Category[]) {
  const title = keywords(input.title), description = keywords(input.description);
  const overlap = (query: Set<string>, terms: Set<string>) => [...query].filter(word => terms.has(word)).length;
  return categories.filter(category => !isFallbackCategory(category.name)).map(category => {
    const official = officialCategoryForName(category.name);
    const labels = keywords([category.name, ...(official?.aliases ?? [])].join(' '));
    // Catalog boundary advice can mention another category; it is not a keyword.
    const examples = keywords(official?.examples.split('.')[0] ?? '');
    const score = overlap(title, labels) * 8 + overlap(title, examples) * 3
      + overlap(description, labels) * 3 + overlap(description, examples);
    return { category, score };
  }).filter(item => item.score >= 3)
    .sort((a, b) => b.score - a.score || a.category.name.localeCompare(b.category.name) || a.category.id.localeCompare(b.category.id))
    .slice(0, 3).map(item => item.category.id);
}
