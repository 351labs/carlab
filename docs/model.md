# Model and limitations

CarLab combines a reduced engine model, powertrain dynamics, procedural audio and illustrative 3D presentation. Configuration and telemetry drive the visual models; the visual models do not feed measurements back into the solver. The Rust core runs natively or in CPU-hosted WebAssembly. See the [API documentation](../api/README.md) for the package interface.

## Cylinder and powertrain

The cylinder model is an air-standard, single-zone, four-stroke model over 720 crank degrees. Slider-crank geometry gives volume; compressible valve flow allows reverse flow and choking. The model integrates working-gas mass and energy with a prescribed finite-duration Wiebe heat release and wall exchange. Fuel is represented as equivalent heat input, not as added gas mass or resolved chemical species. Residual and fresh charge are tracked as a simplified bookkeeping model. An optional temperature-dependent heat-capacity approximation is not an equilibrium chemistry table.

The complete pressure-volume loop gives net indicated work, including pumping work. Brake torque subtracts an assumed or supplied friction model; pumping must not be subtracted a second time. Intake and exhaust reservoirs are mean-value approximations, not CFD or a resolved pipe-wave model. Turbo shaft energy and a pressure target are simplified; complete compressor and turbine maps, compressor surge and choke are not modeled.

Map provenance and domain matter. An assumed or fitted map is not a measurement, and extrapolation is not evidence of accuracy. Numerical conservation or a finite result does not establish physical validity. The reduced dynamic model uses cached operating points, so its approximations and warnings should be considered when interpreting output.

## Heat and materials

A lumped thermal network represents cylinder wall, coolant, oil and exhaust wall as separate states. Gas temperature is not metal temperature. Its heat capacities and conductances are assumptions unless supplied with evidence; local energy accounting does not prove whole-engine energy closure.

The nominal connecting-rod screen uses a pressure trace, kinematics and owner-supplied geometry. Material limits and optional fatigue curves require an attributable, applicable evidence card. Without one, resistance and fatigue are not evaluated. The result omits effects including bending, buckling, contacts and thermal gradients; it is not FEA or a validated service-life prediction.

## Calibration and validation

A meaningful calibration requires measurements appropriate to each subsystem: geometry and valve events, pressure versus crank angle, boundary pressures and temperatures, air and fuel flow, torque, and relevant thermal or material evidence. Separate fitting data from independent validation cases, record operating conditions and uncertainty, and report results only within the tested domain. A fitted torque curve alone cannot identify all model parameters. Spark timing is not necessarily the start of heat release; inlet airflow is not necessarily fresh charge retained at intake-valve closure.

A digital twin of a particular vehicle would additionally need a connection to that vehicle's identity and measured state, a defined update process, and ongoing verification, validation and uncertainty management. These requirements are not implied by a simulation or a successful calibration. [Research references](references.md) describe the basis and limits of these methods.
