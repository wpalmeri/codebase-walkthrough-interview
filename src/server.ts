import { createApp } from "./app";

const port = Number(process.env.PORT ?? 4600);
const app = createApp();
app.listen(port, () => {
  console.log(`billing api listening on http://localhost:${port}`);
});
