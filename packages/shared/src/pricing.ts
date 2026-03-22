/**
 * Lumi Rides - Pricing Engine (Australia / NDIS)
 *
 * This utility calculates trip costs based on distance, duration, and accessibility needs.
 * It is aligned with Australian transport market rates and NDIS support guidelines.
 */

export type PricingContext = {
  distanceKm: number;
  durationMinutes: number;
  vehicleType: "standard" | "accessible";
  isNdis?: boolean;
  timeOfDay?: Date;
};

export type PriceBreakdown = {
  baseFee: number;
  distanceFee: number;
  timeFee: number;
  accessibilityLoading: number;
  total: number;
  currency: string;
};

// Rates based on average Australian private transport + NDIS loading
const RATES = {
  BASE_FEE: 5.50,         // AUD
  KM_RATE_STANDARD: 1.25, // AUD per KM
  KM_RATE_ACCESSIBLE: 2.85, // AUD per KM (NDIS modified vehicle cap is approx $2.76-$3.00)
  TIME_RATE: 0.85,        // AUD per MIN
  ACCESSIBILITY_MIN: 15.00, // Minimum flat loading for hoist engagement
};

/**
 * Calculates the estimated cost of a trip
 */
export function calculateEstimatedPrice(ctx: PricingContext): PriceBreakdown {
  const { distanceKm, durationMinutes, vehicleType, isNdis } = ctx;

  const baseFee = RATES.BASE_FEE;
  
  // NDIS typically pays more per KM for modified vehicles
  const kmRate = vehicleType === "accessible" ? RATES.KM_RATE_ACCESSIBLE : RATES.KM_RATE_STANDARD;
  const distanceFee = distanceKm * kmRate;
  
  const timeFee = durationMinutes * RATES.TIME_RATE;
  
  // Flat loading fee if it's an accessible vehicle trip
  const accessibilityLoading = vehicleType === "accessible" ? RATES.ACCESSIBILITY_MIN : 0;

  let total = baseFee + distanceFee + timeFee + accessibilityLoading;

  // Round to 2 decimal places (AUD)
  return {
    baseFee,
    distanceFee: Number(distanceFee.toFixed(2)),
    timeFee: Number(timeFee.toFixed(2)),
    accessibilityLoading,
    total: Number(total.toFixed(2)),
    currency: "AUD"
  };
}

/**
 * Gets the NDIS support item code if applicable
 */
export function getNdisSupportItem(vehicleType: "standard" | "accessible"): string {
  // Common NDIS Transport codes
  if (vehicleType === "accessible") {
    return "04_590_0125_6_1"; // Specialist Transport
  }
  return "04_591_0125_6_1"; // General Transport
}

/**
 * Calculates distance between two points in KM
 */
export function calculateHaversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // Earth radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}
