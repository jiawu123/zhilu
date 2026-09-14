import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AccountApp } from "./AccountApp";
import { RequestActivity } from "./WaitStatus";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AccountApp />
    <RequestActivity />
  </StrictMode>,
);
