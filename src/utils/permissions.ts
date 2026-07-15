export interface UserPermissions {
  canBrowse: boolean;
  canTransact: boolean;
  canCreateListings: boolean;
  canBookServices: boolean;
  canAcceptBookings: boolean;
  canMessage: boolean;
  canReview: boolean;
  canReport: boolean;
}

export function getUserPermissions(user: any): UserPermissions {
  const isVerified = user.verificationStatus === 'APPROVED';
  const isActive = user.isActive !== false;
  const isAdmin = user.role === 'admin';

  if (isAdmin) {
    return {
      canBrowse: true,
      canTransact: true,
      canCreateListings: true,
      canBookServices: true,
      canAcceptBookings: true,
      canMessage: true,
      canReview: true,
      canReport: true,
    };
  }

  const isEligible = isVerified && isActive;

  return {
    canBrowse: true,
    canTransact: isEligible,
    canCreateListings: isEligible,
    canBookServices: isEligible,
    canAcceptBookings: isEligible,
    canMessage: true,
    canReview: isEligible,
    canReport: true,
  };
}
