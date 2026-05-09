import { Router } from "express";
import authRoutes from "./auth.js";
import userRoutes from "./users.js";
import shiftRoutes from "./shifts.js";
import productRoutes from "./products.js";
import orderRoutes from "./orders.js";
import paymentRoutes from "./payments.js";
import reportRoutes from "./reports.js";
import ledgerRoutes from "./ledger.js";
import inventoryRoutes from "./inventory.js";
import customerRoutes from "./customers.js";
import expenseRoutes from "./expenses.js";
import syncRoutes from "./sync.js";
import notificationRoutes from "./notifications.js";
import branchRoutes from "./branches.js";
import procurementRoutes from "./procurement.js";
import receiptRoutes from "./receipts.js";
import approvalRoutes from "./approvals.js";
import returnRoutes from "./returns.js";
import voidRoutes from "./voids.js";

const router = Router();

router.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "pos-backend",
    /** Dashboard KPI endpoint for deploy verification. */
    features: {
      homeKpisPath: "/api/v1/home/kpis",
      productsExcelImportPath: "/api/v1/products/import/excel",
    },
  });
});

router.use("/auth", authRoutes);
router.use("/users", userRoutes);
router.use("/shifts", shiftRoutes);
router.use("/products", productRoutes);
router.use("/orders", orderRoutes);
router.use("/payments", paymentRoutes);
router.use("/reports", reportRoutes);
router.use("/ledger", ledgerRoutes);
router.use("/inventory", inventoryRoutes);
router.use("/customers", customerRoutes);
router.use("/expenses", expenseRoutes);
router.use("/sync", syncRoutes);
router.use("/notifications", notificationRoutes);
router.use("/branches", branchRoutes);
router.use("/procurement", procurementRoutes);
router.use("/receipts", receiptRoutes);
router.use("/approvals", approvalRoutes);
router.use("/returns", returnRoutes);
router.use("/voids", voidRoutes);

export default router;
