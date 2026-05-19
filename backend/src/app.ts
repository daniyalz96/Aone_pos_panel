import cors from "cors";
import express from "express";
import type { Request, Response } from "express";
import { requireAuth } from "./middleware/auth.js";
import { handleDashboardSummary } from "./routes/dashboardSummary.js";
import { registerExcelMetaAndApplyRoutes, registerExcelUploadRoute } from "./routes/productExcelImport.js";
import routes from "./routes/index.js";

export const app = express();

app.use(cors());

/** Multipart Excel upload — before express.json() so the body stream stays intact for multer. */
registerExcelUploadRoute(app);

/** Default 100kb is too small for bulk JSON (e.g. Excel import apply with many rows). */
app.use(express.json({ limit: "10mb" }));

/** Dashboard KPIs — registered on the app so this path always resolves before nested routers. */
app.get("/api/v1/home/kpis", requireAuth, (req: Request, res: Response) => {
  void handleDashboardSummary(req, res);
});

/** Excel discovery + JSON apply — after express.json(). */
registerExcelMetaAndApplyRoutes(app);

app.use("/api/v1", routes);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = err instanceof Error ? err.message : "Unexpected server error";
  res.status(500).json({ message });
});
