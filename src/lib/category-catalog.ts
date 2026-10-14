/** Plain-language service families shared by seeding, API help, and Admin duplicate checks.
 * Aliases are previous official labels, not extra choices in the public catalog. */
export const SERVICE_CATEGORY_CATALOG = [
  {
    "name": "Aircon Cleaning & Repair",
    "aliases": [
      "Aircon Service",
      "Aircon Repair"
    ],
    "examples": "Aircon cleaning, repairs, installation, and refrigerant checks."
  },
  {
    "name": "Appliance Repair",
    "aliases": [],
    "examples": "Refrigerators, washing machines, stoves, and other household appliances."
  },
  {
    "name": "Bicycle Repair",
    "aliases": [],
    "examples": "Bicycle tune-ups, brakes, tires, and chains."
  },
  {
    "name": "Bookkeeping & Admin Help",
    "aliases": [],
    "examples": "Organizing records, data entry, and routine office tasks."
  },
  {
    "name": "Car Repair & Maintenance",
    "aliases": [
      "Automotive Services"
    ],
    "examples": "Car repairs, oil changes, battery checks, and detailing."
  },
  {
    "name": "Carpentry & Furniture Repair",
    "aliases": [
      "Carpentry & Woodwork"
    ],
    "examples": "Cabinets, shelves, wooden furniture, and wood repairs."
  },
  {
    "name": "Computer & Laptop Repair",
    "aliases": [
      "Computer / IT Services"
    ],
    "examples": "Laptop and desktop repairs, software fixes, printers, and data recovery. For routers, choose Internet & Wi-Fi Setup."
  },
  {
    "name": "Cooking & Catering",
    "aliases": [],
    "examples": "Meal preparation, food trays, and catering for gatherings."
  },
  {
    "name": "Delivery, Moving & Errands",
    "aliases": [
      "Delivery & Moving"
    ],
    "examples": "Deliveries, moving furniture, and local errands."
  },
  {
    "name": "Electrical Wiring & Repairs",
    "aliases": [
      "Electrical Repair"
    ],
    "examples": "Wiring, outlets, lights, and circuit breakers. For laptops or appliances, choose their repair category."
  },
  {
    "name": "Event Planning & Setup",
    "aliases": [
      "Event Services"
    ],
    "examples": "Planning events, decorations, equipment, and venue setup. Food and photography have their own categories."
  },
  {
    "name": "Gardening & Landscaping",
    "aliases": [
      "Lawn & Garden",
      "Lawn Care"
    ],
    "examples": "Grass cutting, plant care, garden cleanup, and landscaping."
  },
  {
    "name": "Haircuts & Beauty",
    "aliases": [
      "Beauty & Personal Care",
      "Haircut"
    ],
    "examples": "Haircuts, styling, makeup, and nail services."
  },
  {
    "name": "Handyman & Small Home Repairs",
    "aliases": [
      "Handyman Services"
    ],
    "examples": "Small household fixes and assembly. Wiring, plumbing, and major renovations have their own categories."
  },
  {
    "name": "Home & Office Cleaning",
    "aliases": [
      "Cleaning Services",
      "House Cleaning"
    ],
    "examples": "House, office, deep cleaning, and cleanup after a move. For clothes, choose Laundry & Ironing."
  },
  {
    "name": "Home Renovation & Masonry",
    "aliases": [
      "Home Improvement"
    ],
    "examples": "Renovations, concrete work, tiling, and structural home improvements."
  },
  {
    "name": "Internet & Wi-Fi Setup",
    "aliases": [],
    "examples": "Router setup, home networks, and Wi-Fi troubleshooting."
  },
  {
    "name": "Laundry & Ironing",
    "aliases": [],
    "examples": "Washing clothes, ironing, and laundry pickup."
  },
  {
    "name": "Locks & Keys",
    "aliases": [],
    "examples": "Lock repairs, key cutting, and help with a lockout."
  },
  {
    "name": "Motorcycle Repair & Maintenance",
    "aliases": [],
    "examples": "Motorcycle repairs, servicing, and tire or brake checks."
  },
  {
    "name": "Musical Instrument Repair & Tuning",
    "aliases": [],
    "examples": "Instrument repairs and tuning. For music lessons, choose Tutoring & Lessons."
  },
  {
    "name": "Painting",
    "aliases": [
      "Painting Services"
    ],
    "examples": "Indoor and outdoor painting, surface preparation, and touch-ups."
  },
  {
    "name": "Pest Control",
    "aliases": [],
    "examples": "Help with termites, rodents, and household pests."
  },
  {
    "name": "Pet Grooming & Care",
    "aliases": [
      "Pet Services"
    ],
    "examples": "Pet grooming, sitting, walking, and everyday care."
  },
  {
    "name": "Phone & Tablet Repair",
    "aliases": [],
    "examples": "Screen, battery, charging, and software repairs for phones and tablets."
  },
  {
    "name": "Photography & Video",
    "aliases": [
      "Photography / Videography"
    ],
    "examples": "Photos, video shoots, and photo or video editing."
  },
  {
    "name": "Plumbing",
    "aliases": [],
    "examples": "Pipes, faucets, toilets, drains, and water leaks."
  },
  {
    "name": "Printing & Graphic Design",
    "aliases": [],
    "examples": "Print jobs, invitations, signs, logos, and graphic design."
  },
  {
    "name": "Roof & Gutter Repairs",
    "aliases": [],
    "examples": "Roof leaks, roofing repairs, gutter repairs, and gutter cleaning."
  },
  {
    "name": "Tailoring & Clothing Repairs",
    "aliases": [],
    "examples": "Alterations, sewing, uniforms, and repairing clothes."
  },
  {
    "name": "Translation & Writing",
    "aliases": [],
    "examples": "Translation, proofreading, writing, and transcription."
  },
  {
    "name": "Tutoring & Lessons",
    "aliases": [
      "Tutoring & Education",
      "Tutoring"
    ],
    "examples": "School tutoring, language lessons, music lessons, and skills coaching."
  },
  {
    "name": "Website & Software Services",
    "aliases": [],
    "examples": "Building or fixing websites, apps, and other software."
  },
  {
    "name": "Welding & Metalwork",
    "aliases": [],
    "examples": "Welding, gates, railings, and metal repairs."
  },
  {
    "name": "Other Services",
    "aliases": [
      "Repair & Maintenance"
    ],
    "examples": "Choose this only when no listed category fits. Describe the work clearly."
  }
] as const;

export const OTHER_SERVICES_CATEGORY = 'Other Services';
export const DEFAULT_SERVICE_CATEGORIES = SERVICE_CATEGORY_CATALOG.map(category => category.name);

export function normalizedCategoryName(name: string) {
  return name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-PH');
}

function nameKey(name: string) {
  return normalizedCategoryName(name).replace(/[&/]+/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

export function officialCategoryForName(name: string) {
  const key = nameKey(name);
  return SERVICE_CATEGORY_CATALOG.find(category => [category.name, ...category.aliases].some(label => nameKey(label) === key));
}

export function canonicalCategoryName(name: string) {
  return officialCategoryForName(name)?.name ?? name.normalize('NFKC').trim().replace(/\s+/g, ' ');
}

export function categoryConceptKey(name: string) {
  return nameKey(canonicalCategoryName(name));
}

export function isFallbackCategory(name: string) {
  return normalizedCategoryName(name) === normalizedCategoryName(OTHER_SERVICES_CATEGORY);
}
