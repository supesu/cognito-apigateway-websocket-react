import Image from "next/image";
import { ExampleComponent as Component } from "./component";
import { ExampleComponent as Component2 } from "./component_two";

export default function Home() {
  return (
    <div className="flex flex-col w-full h-full">
      <Component></Component>
      <Component2></Component2>
    </div>
  );
}
