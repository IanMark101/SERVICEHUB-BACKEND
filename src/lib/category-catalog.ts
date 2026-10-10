export const OTHER_SERVICES_CATEGORY = 'Other Services';
export const DEFAULT_SERVICE_CATEGORIES = [
  'Aircon Service', 'Appliance Repair', 'Automotive Services', 'Beauty & Personal Care',
  'Carpentry & Woodwork', 'Cleaning Services', 'Computer / IT Services', 'Delivery & Moving',
  'Electrical Repair', 'Event Services', 'Handyman Services', 'Home Improvement',
  'Lawn & Garden', 'Painting Services', 'Pest Control', 'Pet Services',
  'Photography / Videography', 'Plumbing', 'Repair & Maintenance', 'Tutoring & Education',
  OTHER_SERVICES_CATEGORY,
] as const;
export function normalizedCategoryName(name: string) {
  return name.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-PH');
}
export function isFallbackCategory(name: string) {
  return normalizedCategoryName(name) === normalizedCategoryName(OTHER_SERVICES_CATEGORY);
}
