import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AccountApp } from "./AccountApp";
import { RequestActivity } from "./WaitStatus";
import { InteractionMotion } from "./InteractionMotion";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <InteractionMotion />
    <AccountApp />
    <RequestActivity />
  </StrictMode>,
);
