export const gateMessage = (status: string) => status === "rejected"
  ? "This workspace could not be verified, so it is read-only. Contact support if you believe this is a mistake."
  : status === "in_review" ? "Your company is being reviewed by our team. The workspace becomes editable as soon as it is approved."
  : "Confirm your email and mobile number and upload your trade licence to activate this workspace.";
