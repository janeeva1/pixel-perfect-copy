// Global error handlers for client-side
if (typeof window !== "undefined") {
  window.addEventListener("unhandledrejection", (event) => {
    console.error("UNHANDLED REJECTION:", event.reason);
    console.error("Stack:", event.reason?.stack);
  });

  window.addEventListener("error", (event) => {
    console.error("GLOBAL ERROR:", event.error || event.message);
    if (event.error?.stack) {
      console.error("Stack:", event.error.stack);
    }
  });
}

export {};
