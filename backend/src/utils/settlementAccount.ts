export function settlementAccountByMethod(method: "cash" | "card" | "qr" | "wallet" | "bank") {
  return method === "bank" || method === "card" ? "1010" : "1000";
}
