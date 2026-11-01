# Research and credits

These sources inform the modeling approach and its limitations. A source's experimental results, coefficients or accuracy do not automatically apply to CarLab. Links are references, not permission to reproduce figures, datasets or code; consult each source's terms before reuse. The MIT course includes some third-party figures excluded from its open licence.

## Engine physics and measurement

- Wai Cheng, MIT 2.61, [engine operating characteristics](https://ocw.mit.edu/courses/2-61-internal-combustion-engines-spring-2017/cf3aaf55ae71710c9bfd3056515b9b67_MIT2_61S17_lec2.pdf), [ideal cycles](https://ocw.mit.edu/courses/2-61-internal-combustion-engines-spring-2017/e9421a34d0cd5c5fc4fc81365975503e_MIT2_61S17_lec3.pdf), [gas properties](https://ocw.mit.edu/courses/2-61-internal-combustion-engines-spring-2017/79a4fb328edcbb374b313f305396bd6a_MIT2_61S17_lec6.pdf), [heat transfer](https://ocw.mit.edu/courses/2-61-internal-combustion-engines-spring-2017/df96f507776900c0dde50a4b50f422ce_MIT2_61S17_lec18.pdf), [friction](https://ocw.mit.edu/courses/2-61-internal-combustion-engines-spring-2017/ad971a51c4a7f2db8a20f9570c870f0d_MIT2_61S17_lec19.pdf) and [turbocharging](https://ocw.mit.edu/courses/2-61-internal-combustion-engines-spring-2017/6b7b9273297b0993ffad47a4f463b641_MIT2_61S17_lec20.pdf), 2017. These establish distinctions among ideal cycles, losses and practical operating conditions.
- Chandrakar, Varma and Mittal, [thermodynamic cylinder-cycle submodels](https://doi.org/10.1038/s41598-025-15819-7), 2025. The article is published under CC BY-NC-ND 4.0; CarLab cites it without reproducing its figures or data.
- Linemburg, [zero-dimensional spark-ignition model](https://repositorio.ufsc.br/handle/123456789/187807), 2017. Results concern the investigated engine and conditions.
- Ellies, Schenk and Dekraker, US EPA, [engine benchmarking and hardware-in-the-loop operation](https://www.epa.gov/sites/default/files/2016-10/documents/2016-01-1007-benchmark-hil-operat-2014-mazda-skyactiv-2.0l.pdf), SAE 2016-01-1007. A specific measured engine is not a universal calibration.
- Dekraker et al., US EPA, [combining data into complete engine maps](https://www.epa.gov/vehicle-and-fuel-emissions-testing/combining-data-complete-engine-alpha-maps), SAE 2018-01-1412. Measured and estimated regions need distinct provenance.
- Sandoval and Heywood, [friction model for spark-ignition engines](https://doi.org/10.4271/2003-01-0725), 2003; Woschni, [instantaneous heat-transfer coefficient](https://doi.org/10.4271/670931), 1967. These identify useful physical structures; published coefficients require their own applicability and reuse review.
- [Cantera species thermodynamic models](https://cantera.org/stable/reference/thermo/species-thermo.html) describes NASA polynomial representations. CarLab's simplified heat-capacity option is not a NASA coefficient dataset.

## Validation, materials and audio

- Prah, Trenc and Katrašnik, [system-level engine model calibration](https://doi.org/10.3390/en9090708), 2016: subsystem calibration and parameter dependence.
- Gonder et al., NREL, [FASTSim validation report](https://afdc.energy.gov/files/u/publication/fastsim_validation_rpt.pdf), 2018: a vehicle-model validation example, not an accuracy claim for CarLab.
- Shao, Hightower and Schindel, NIST, [credibility considerations for digital twins](https://www.nist.gov/publications/credibility-consideration-digital-twins-manufacturing), 2022: verification, validation, uncertainty and intended use.
- Xu et al., [connecting-rod fatigue methodology](https://doi.org/10.1177/09544070231180996), 2023: geometry, load history and material evidence are needed beyond nominal stress.
- Baldan et al., [physically informed engine sound synthesis](https://doi.org/10.1109/SIVE.2015.7361287), 2015: a reference for separating engine acoustic sources and propagation.

## Distributed third-party material

The listening reference **ferrari340america2.mp3** is by **enginemusic**, sourced from [Freesound](https://freesound.org/people/enginemusic/sounds/43483/) under [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). The linked public preview is unchanged; see the [full attribution](../public/references/ATTRIBUTION.md) for source, transformations and context. It is a listening reference, not a sample in the procedural generator.

Consult [Rust dependency notices](../native/THIRD_PARTY_NOTICES.md), the package distribution notices, and the installed dependencies' own licence files for third-party code. References to research and third-party licences do not grant a licence to CarLab's own code.
