import { Prisma } from '@prisma/client';
import { JobLocationSchema, BookingLocationModeSchema, type BookingLocationMode, type ServiceLocationMode, type JobLocation } from '../schema/location.schema';
import { assertJobLocation, locationFromRecord } from './proximity';

type ServiceVenue = {
  serviceLocationMode?: ServiceLocationMode;
  latitude?: number | null; longitude?: number | null; locationLabel?: string | null;
  venueAddress?: string | null; coverageRadiusKm?: number | null;
  transportationFee?: Prisma.Decimal | null;
};
type RequestLocation = ServiceVenue & { privateAddress?: string | null };
const failure = (message: string) => Object.assign(new Error(message), { status: 400, code: 'SERVICE_ARRANGEMENT_INVALID' });

/** Physical arrangements share one discovery point. Only an unlocated record
 * needs a new point when becoming a physical listing. */
export function assertLocationForArrangementChange(previous: ServiceLocationMode, next: ServiceLocationMode | undefined, location: unknown, areaMode: 'PROVIDER_VISITS' | 'SEEKER_VISITS') {
  void areaMode;
  if (next && next !== 'REMOTE' && previous === 'REMOTE' && !location) {
    throw failure('Choose your discovery location so nearby users can find this listing.');
  }
}

export function resolveVisitMode(available: ServiceLocationMode | undefined, selected?: BookingLocationMode): BookingLocationMode {
  const supported = available ?? 'PROVIDER_VISITS';
  if (!selected && supported === 'BOTH') throw failure('Choose whether the provider visits or the seeker visits the provider.');
  const mode = BookingLocationModeSchema.parse(selected ?? supported);
  if (supported === 'BOTH' ? mode === 'REMOTE' : mode !== supported) throw failure('This service arrangement is not available. Review the listing or request and choose an available arrangement.');
  return mode;
}

export function providerVenue(service: ServiceVenue): JobLocation {
  if (service.venueAddress?.trim()) return JobLocationSchema.parse({ label: service.locationLabel || 'Provider workplace', address: service.venueAddress });
  // Retain venues explicitly pinned by older listings. New shop listings save
  // a separate workplace address and never promote a discovery point to a venue.
  const point = locationFromRecord({ ...service, privateAddress: service.venueAddress });
  if (!point) throw failure('The provider must set a service venue before accepting visits.');
  return JobLocationSchema.parse(point);
}

export function resolveDirectArrangement(service: ServiceVenue, selected?: BookingLocationMode, jobLocation?: JobLocation) {
  const serviceLocationMode = resolveVisitMode(service.serviceLocationMode, selected);
  if (serviceLocationMode === 'REMOTE') {
    return { serviceLocationMode, jobLocation: undefined, transportationFee: new Prisma.Decimal(0) };
  }
  if (serviceLocationMode === 'SEEKER_VISITS') {
    return { serviceLocationMode, jobLocation: providerVenue(service), transportationFee: new Prisma.Decimal(0) };
  }
  // Historical unlocated listings retain their existing cash booking behavior.
  if (jobLocation || (service.latitude != null && service.longitude != null)) assertJobLocation(jobLocation);
  return { serviceLocationMode, jobLocation, transportationFee: service.transportationFee ?? null };
}

export function resolveOfferArrangement(request: RequestLocation, service: ServiceVenue | null, selected?: BookingLocationMode, customVenue?: JobLocation) {
  const serviceLocationMode = resolveVisitMode(request.serviceLocationMode, selected);
  if (service) resolveVisitMode(service.serviceLocationMode, serviceLocationMode);
  if (serviceLocationMode === 'REMOTE') return { serviceLocationMode, providerVenue: undefined };
  if (serviceLocationMode === 'SEEKER_VISITS') {
    if (!service && !customVenue) throw failure('Choose your service venue so the seeker knows where the work will happen.');
    return { serviceLocationMode, providerVenue: service ? providerVenue(service) : JobLocationSchema.parse(customVenue) };
  }
  return { serviceLocationMode, providerVenue: undefined };
}

export function offerJobLocation(offer: { serviceLocationMode?: ServiceLocationMode | null; providerVenue?: unknown; request: RequestLocation & { targetServiceId?: string | null } }, selectedJobLocation?: JobLocation) {
  if (offer.serviceLocationMode === 'REMOTE') return undefined;
  if (offer.serviceLocationMode === 'SEEKER_VISITS') return JobLocationSchema.parse(offer.providerVenue);
  if (selectedJobLocation) return JobLocationSchema.parse(selectedJobLocation);
  // Private listing inquiries already collected the job address. Public
  // discovery posts collect it at acceptance, independently of their map pin.
  if (!offer.request.targetServiceId && !offer.request.privateAddress && offer.request.latitude != null) assertJobLocation(undefined);
  return locationFromRecord(offer.request) ?? (offer.request.privateAddress ? JobLocationSchema.parse({ label:offer.request.locationLabel || 'Job address', address:offer.request.privateAddress }) : undefined);
}

/** An unpaid offer may disclose its general venue area, never its exact pin/address. */
export function publicOffer<T extends { providerVenue?: unknown }>(offer: T) {
  const { providerVenue: privateVenue, ...visible } = offer;
  const venue = JobLocationSchema.safeParse(privateVenue);
  return { ...visible, venueLabel: venue.success ? venue.data.label : undefined };
}
