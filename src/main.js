import { SpiderApp } from "./ui/app.js";

const app = new SpiderApp(document);
app.start().catch((error) => {
  console.error(error);
  app.showFatal(error);
});

globalThis.spiderApp = app;
