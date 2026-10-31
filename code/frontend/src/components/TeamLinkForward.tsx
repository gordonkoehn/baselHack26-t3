"use client";

import { useEffect } from "react";

/**
 * Team links pinned before the homepage existed point at "/?code=…". The passcode is read by the
 * studio, so a link with a code goes straight there, keeping the rest of the query.
 */
export function TeamLinkForward() {
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.get("code")) window.location.replace(`/studio${url.search}${url.hash}`);
    } catch {}
  }, []);
  return null;
}
