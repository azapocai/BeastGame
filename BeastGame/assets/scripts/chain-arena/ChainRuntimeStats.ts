/** Reused development counters. They intentionally never log per frame. */
export class ChainRuntimeStats {
  frame = 0;
  routeBuilds = 0;
  publishedRoutes = 0;
  routePoints = 0;
  exactIntersectionTests = 0;
  broadPhaseCandidates = 0;
  constraintIterations = 0;
  activeContacts = 0;
  visibleLinks = 0;
  guideNodes = 0;
  guideSubsteps = 0;
  enclosedCandidates = 0;

  beginFrame(): void {
    this.frame += 1;
    this.routeBuilds = 0;
    this.publishedRoutes = 0;
    this.routePoints = 0;
    this.exactIntersectionTests = 0;
    this.broadPhaseCandidates = 0;
    this.constraintIterations = 0;
    this.activeContacts = 0;
    this.visibleLinks = 0;
    this.guideNodes = 0;
    this.guideSubsteps = 0;
    this.enclosedCandidates = 0;
  }
}
