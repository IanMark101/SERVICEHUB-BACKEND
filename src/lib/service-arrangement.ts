import { Prisma } from '@prisma/client';
import { JobLocationSchema, BookingLocationModeSchema, type BookingLocationMode, type ServiceLocationMode, type JobLocation } from '../schema/location.schema';
import { assertServiceCoverage, locationFromRecord } from './proximity';

type ServiceVenue = {
  serviceLocationMode?: ServiceLocationMode;
  latitude?: number | null; longitude?: number | null; locationLabel?: string | null;
  venueAddress?: string | null; coverageRadiusKm?: number | null;
  transportationFee?: Prisma.Decimal | null;
};
type RequestLocation = ServiceVenue & { privateAddress?: string | null };
const failure = (message: string) => Object.assign(new Error(message), { status: 400, code: 'SERVICE_ARRANGEMENT_INVALID' });

/** A discovery area must never silently become an exact job pin or visit venue. */
export function assertLocationForArrangementChange(previous: ServiceLocationMode, next: ServiceLocationMode | undefined, location: unknown, areaMode: 'PROVIDER_VISITS' | 'SEEKER_VISITS') {
  if (next && (previous === areaMode) !== (next === areaMode) && !location) {
    throw failure('Choose a new location for this arrangement. General search areas cannot be reused as exact job locations or provider venues.');
  }
}

export function resolveVisitMode(available: ServiceLocationMode | undefined, selected?: BookingLocationMode): BookingLocationMode {
  const supported = available ?? 'PROVIDER_VISITS';
  if (!selected && supported === 'BOTH') throw failure('Choose whether the provider visits or the seeker visits the provider.');
  const mode = BookingLocationModeSchema.parse(selected ?? supported);
  if (supported !== 'BOTH' && mode !== supported) throw failure('This service arrangement is not available. Review the listing or request and choose an available arrangement.');
  return mode;
}

export function providerVenue(service: ServiceVenue): JobLocation {
  const point = locationFromRecord({ ...service, privateAddress: service.venueAddress });
  if (!point) throw failure('The provider must set a service venue before accepting visits.');
  return JobLocationSchema.parse(point);
}

export function resolveDirectArrangement(service: ServiceVenue, selected?: BookingLocationMode, jobLocation?: JobLocation) {
  const serviceLocationMode = resolveVisitMode(service.serviceLocationMode, selected);
  if (serviceLocationMode === 'SEEKER_VISITS') {
    return { serviceLocationMode, jobLocation: providerVenue(service), transportationFee: new Prisma.Decimal(0) };
  }
  assertServiceCoverage(service, jobLocation);
  return { serviceLocationMode, jobLocation, transportationFee: service.transportationFee ?? null };
}

export function resolveOfferArrangement(request: RequestLocation, service: ServiceVenue | null, selected?: BookingLocationMode, customVenue?: JobLocation) {
  const serviceLocationMode = resolveVisitMode(request.serviceLocationMode, selected);
  if (service) resolveVisitMode(service.serviceLocationMode, serviceLocationMode);
  if (serviceLocationMode === 'SEEKER_VISITS') {
    if (!service && !customVenue) throw failure('Choose your service venue so the seeker knows where the work will happen.');
    return { serviceLocationMode, providerVenue: service ? providerVenue(service) : JobLocationSchema.parse(customVenue) };
  }
  if (service) assertServiceCoverage(service, locationFromRecord(request));
  return { serviceLocationMode, providerVenue: undefined };
}

export function offerJobLocation(offer: { serviceLocationMode?: ServiceLocationMode | null; providerVenue?: unknown; request: RequestLocation }) {
  if (offer.serviceLocationMode === 'SEEKER_VISITS') return JobLocationSchema.parse(offer.providerVenue);
  return locationFromRecord(offer.request);
}

/** An unpaid offer may disclose its general venue area, never its exact pin/address. */
export function publicOffer<T extends { providerVenue?: unknown }>(offer: T) {
  const { providerVenue: privateVenue, ...visible } = offer;
  const venue = JobLocationSchema.safeParse(privateVenue);
  return { ...visible, venueLabel: venue.success ? venue.data.label : undefined };
}
