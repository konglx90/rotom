/**
 * Real-person enum: human team members who can own issues / approve.
 * Split from the protocol god-file so consumers needing only the enum don't
 * pull in the full message union.
 */

export const REAL_PERSONS = ["孔令飞"] as const;
export type RealPerson = typeof REAL_PERSONS[number];
