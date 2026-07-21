// Between Mirror — the demo's standing disclosure.
//
// Permanent and non-dismissible, because the single most damaging misreading of this page would be
// someone believing they are looking at real messages, or that a service somewhere is holding them.
// Both sentences below are load-bearing and are asserted in the test suite: who these people are
// (nobody), and where a real archive would live (the reader's own machine, never here).
export function DemoBanner() {
  return (
    <div className="demo-banner" role="note">
      <strong>This is a demonstration.</strong>{' '}
      A fictional couple (Alex &amp; Jordan). Between Mirror never hosts real archives — yours would
      stay on your machine.
    </div>
  );
}
