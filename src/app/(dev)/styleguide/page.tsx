import { notFound } from "next/navigation";
import { StyleguideBoard } from "./styleguide-board";

export const metadata = {
  title: "Styleguide · Kittie",
};

export default function StyleguidePage() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }
  return <StyleguideBoard />;
}
