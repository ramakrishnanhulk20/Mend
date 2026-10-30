// Covers the group names, rule lines, shares and the caption text of the first proof block.
// Does NOT cover how GroupsChart draws them or animates them.
import { describe, expect, it } from "vitest";
import type { ForecastBands } from "../live/summary";
import { GROUPS, groupName, groupRule, groupShare, groupsCaption, trimNumber } from "./groups";

const CONVERGED_DATES = ["2010-09-09", "2010-12-09", "2011-03-09", "2011-06-09", "2011-09-09"];

const BANDS: ForecastBands = {
  likelyGoneBelow: 0.1,
  likelyBackFrom: 1,
  regularMinDays: 3,
  silentMinDays: 60,
  horizonWeeks: 13,
  pooled: {
    likelyGone: { customers: 92, returned: 9 },
    worthANudge: { customers: 3595, returned: 1371 },
    likelyBack: { customers: 1088, returned: 653 },
  },
  rising: true,
  cutoffs: [
    { cutoff: "2010-06-09", converged: false, likelyGone: null, worthANudge: null, likelyBack: null },
    ...CONVERGED_DATES.map((cutoff) => ({
      cutoff,
      converged: true,
      likelyGone: { customers: 18, returned: 2 },
      worthANudge: { customers: 719, returned: 274 },
      likelyBack: { customers: 218, returned: 131 },
    })),
  ],
};

describe("trimNumber", () => {
  it("drops trailing zeros", () => {
    expect(trimNumber(0.1)).toBe("0.1");
    expect(trimNumber(1)).toBe("1");
    expect(trimNumber(0.25)).toBe("0.25");
  });
});

describe("groupName", () => {
  it("names the three groups in order", () => {
    expect(GROUPS.map(groupName)).toEqual(["Likely gone", "Worth a nudge", "Likely back anyway"]);
  });
});

describe("groupRule", () => {
  it("states the order range for each group from the cut points", () => {
    expect(groupRule("likelyGone", BANDS)).toBe("Under 0.1 orders expected");
    expect(groupRule("worthANudge", BANDS)).toBe("0.1 to under 1 orders expected");
    expect(groupRule("likelyBack", BANDS)).toBe("1 or more orders expected");
  });

  it("follows other cut points", () => {
    const moved = { ...BANDS, likelyGoneBelow: 0.25, likelyBackFrom: 2 };
    expect(groupRule("worthANudge", moved)).toBe("0.25 to under 2 orders expected");
  });
});

describe("groupShare", () => {
  it("divides returned by customers", () => {
    expect(groupShare(BANDS.pooled.likelyGone)).toBeCloseTo(9 / 92, 10);
    expect(groupShare(BANDS.pooled.worthANudge)).toBeCloseTo(1371 / 3595, 10);
    expect(groupShare(BANDS.pooled.likelyBack)).toBeCloseTo(653 / 1088, 10);
  });

  it("is null when the group is empty", () => {
    expect(groupShare({ customers: 0, returned: 0 })).toBeNull();
  });
});

describe("groupsCaption", () => {
  const BASE =
    "Quiet regulars, customers who bought on 3 or more days and then went silent for 60 or more, at 5 past dates in the shop's history, 9 Sep 2010 to 9 Sep 2011. Each was put in a group by how many orders Mend's forecast expected over the next 13 weeks, and each bar is the share who bought again within 91 days with no cashback at all.";

  it("defines a quiet regular, counts only the converged dates, and says why only the middle group is nudged", () => {
    expect(groupsCaption(BANDS, 91)).toBe(
      `${BASE} Mend nudges only the middle group: the likely gone rarely answer a nudge, and the likely back mostly return without one.`,
    );
  });

  it("says the split is not supported when the shares do not rise", () => {
    expect(groupsCaption({ ...BANDS, rising: false }, 91)).toBe(
      `${BASE} Mend nudges only the middle group. On this history the shares do not rise from group to group, so the split is not supported.`,
    );
  });

  it("follows other quiet regular rules", () => {
    const caption = groupsCaption({ ...BANDS, regularMinDays: 5, silentMinDays: 90 }, 91);
    expect(caption).toContain("bought on 5 or more days and then went silent for 90 or more");
  });

  it("says not measured when no date was fitted", () => {
    const none: ForecastBands = {
      ...BANDS,
      cutoffs: [{ cutoff: "2010-06-09", converged: false, likelyGone: null, worthANudge: null, likelyBack: null }],
    };
    expect(groupsCaption(none, 91)).toBe("Not measured yet.");
    expect(groupsCaption({ ...BANDS, cutoffs: [] }, 91)).toBe("Not measured yet.");
  });
});
