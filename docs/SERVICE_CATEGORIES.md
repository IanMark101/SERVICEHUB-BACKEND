# Service categories

The official catalog is shared by provider service listings and seeker requests. Category IDs come from the backend; the frontend never invents IDs. New listings should use the most specific category available. Other Services remains the fallback. Previous official category-name filters and bookmarks resolve to the renamed family; aliases never become additional public choices.

The October 2026 cleanup replaces overlapping choices with 35 plain-language service families. Selected-category help explains the boundary between similar services. Adding a category does not establish a provider's qualifications or change verification and content rules.

## Consolidated choices

| Previous choices | Current choice |
| --- | --- |
| House Cleaning / Cleaning Services | Home & Office Cleaning |
| Lawn Care / Lawn & Garden | Gardening & Landscaping |
| Tutoring / Tutoring & Education | Tutoring & Lessons |
| Repair & Maintenance | Other Services (use a specific repair category when possible) |
| Electrical Repair | Electrical Wiring & Repairs |
| Computer / IT Services | Computer & Laptop Repair |
| Handyman Services | Handyman & Small Home Repairs |
| Home Improvement | Home Renovation & Masonry |

Laptop repairs now have an explicit choice separate from wiring. Phone repair, Wi-Fi setup and software development also have separate choices. Historical listing titles are not used to guess a replacement category. Owners select the appropriate category when publishing a new listing or reposting a request.

## Official families

| Category | What belongs here |
| --- | --- |
| Aircon Cleaning & Repair | Aircon cleaning, repairs, installation, and refrigerant checks. |
| Appliance Repair | Refrigerators, washing machines, stoves, and other household appliances. |
| Bicycle Repair | Bicycle tune-ups, brakes, tires, and chains. |
| Bookkeeping & Admin Help | Organizing records, data entry, and routine office tasks. |
| Car Repair & Maintenance | Car repairs, oil changes, battery checks, and detailing. |
| Carpentry & Furniture Repair | Cabinets, shelves, wooden furniture, and wood repairs. |
| Computer & Laptop Repair | Laptop and desktop repairs, software fixes, printers, and data recovery. For routers, choose Internet & Wi-Fi Setup. |
| Cooking & Catering | Meal preparation, food trays, and catering for gatherings. |
| Delivery, Moving & Errands | Deliveries, moving furniture, and local errands. |
| Electrical Wiring & Repairs | Wiring, outlets, lights, and circuit breakers. For laptops or appliances, choose their repair category. |
| Event Planning & Setup | Planning events, decorations, equipment, and venue setup. Food and photography have their own categories. |
| Gardening & Landscaping | Grass cutting, plant care, garden cleanup, and landscaping. |
| Haircuts & Beauty | Haircuts, styling, makeup, and nail services. |
| Handyman & Small Home Repairs | Small household fixes and assembly. Wiring, plumbing, and major renovations have their own categories. |
| Home & Office Cleaning | House, office, deep cleaning, and cleanup after a move. For clothes, choose Laundry & Ironing. |
| Home Renovation & Masonry | Renovations, concrete work, tiling, and structural home improvements. |
| Internet & Wi-Fi Setup | Router setup, home networks, and Wi-Fi troubleshooting. |
| Laundry & Ironing | Washing clothes, ironing, and laundry pickup. |
| Locks & Keys | Lock repairs, key cutting, and help with a lockout. |
| Motorcycle Repair & Maintenance | Motorcycle repairs, servicing, and tire or brake checks. |
| Musical Instrument Repair & Tuning | Instrument repairs and tuning. For music lessons, choose Tutoring & Lessons. |
| Painting | Indoor and outdoor painting, surface preparation, and touch-ups. |
| Pest Control | Help with termites, rodents, and household pests. |
| Pet Grooming & Care | Pet grooming, sitting, walking, and everyday care. |
| Phone & Tablet Repair | Screen, battery, charging, and software repairs for phones and tablets. |
| Photography & Video | Photos, video shoots, and photo or video editing. |
| Plumbing | Pipes, faucets, toilets, drains, and water leaks. |
| Printing & Graphic Design | Print jobs, invitations, signs, logos, and graphic design. |
| Roof & Gutter Repairs | Roof leaks, roofing repairs, gutter repairs, and gutter cleaning. |
| Tailoring & Clothing Repairs | Alterations, sewing, uniforms, and repairing clothes. |
| Translation & Writing | Translation, proofreading, writing, and transcription. |
| Tutoring & Lessons | School tutoring, language lessons, music lessons, and skills coaching. |
| Website & Software Services | Building or fixing websites, apps, and other software. |
| Welding & Metalwork | Welding, gates, railings, and metal repairs. |
| Other Services | Choose this only when no listed category fits. Describe the work clearly. |

## Deployment and data preservation

Migration `20261013020000_service_category_cleanup` runs atomically and briefly blocks writes to category/listing tables. For each family it keeps an existing canonical row, or renames a matching legacy row while preserving its ID and active/inactive status. Both service and request references on duplicate rows move to the same surviving ID. Retired duplicate rows remain inactive for audit references. Custom Admin categories remain unchanged; inactive categories remain inactive; Other Services is kept active. Bookings, offers, photos, content, payments and accounts are not deleted or rewritten.

Use `npx tsx scripts/migrate-development-categories.ts` only on the recorded development target. It verifies NODE_ENV, refuses unrelated pending migrations, saves a local category/reference snapshot, deploys the migration and checks reference preservation. Normal deployment uses Prisma migration deploy. Seeding uses the new families without reintroducing known aliases or undoing Admin decisions.

Admin creation, rename and reactivation compare normalized concept keys, including known previous names and case/spacing/punctuation variants. Historical duplicate rows cannot become a second active choice. Unrelated custom categories are still supported; unknown semantic overlap requires Admin judgment.

## Verification

The category cleanup integration runs only in a disposable migration-test schema. It rehearses populated legacy categories and checks both listing references, historical audit IDs, inactive/custom category preservation, repeated migration/seed behavior, category help and Admin duplicate guards. The expanded-catalog suite covers both publication APIs, filters, custom categories, fallback, offers and cash bookings. Frontend tests cover shared IDs, retired choices and selected-category help.

