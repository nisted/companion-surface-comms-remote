# Comms Remote Surface

Shows the Comms Remote V2 box's 3x2 touch grid as a Companion surface over USB.

* Plug the box into the Companion machine by USB. It appears under **Surfaces** as *Comms Remote V2 (COMx)*.
* Assign it a page like any other surface. Buttons are drawn at 76x76 and touches press them.
* Close the Arduino serial monitor (or anything else using the COM port) first - only one program can hold the port.
* If the box isn't found, use **Rescan USB** on the Surfaces page.
