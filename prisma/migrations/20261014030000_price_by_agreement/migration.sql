-- Add a distinct supported mode without reviving historical STARTS_AT/CUSTOM records.
ALTER TYPE "PriceType" ADD VALUE 'BY_AGREEMENT';
