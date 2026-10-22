# Image safety model notice

`model-int8.onnx` is an INT8-quantized derivative of
[`abhi099k/image-multi-detect`](https://huggingface.co/abhi099k/image-multi-detect),
revision `bc2e3ac9e09f12fc9f96187ba3c90a26292d2b52`.

- Upstream license metadata: MIT
- Upstream SHA-256 (`model.onnx`):
  `fd36b610b1a280763238bb750885e56838965fbdad0c6b634cb1ea064eb060d3`
- Local quantized SHA-256 (`model-int8.onnx`):
  `d2a13d48096eba2409587b8dad4f145a7314a7e3f75b8e08e35aedde08e3d6d8`
- Architecture: ResNet-50, 224 x 224 RGB input, eight independent logits
- Labels: nsfw, violence, weapon, smoking, alcohol, drugs, sensitive, hate

Weights are symmetrically quantized to signed INT8 per output channel and
dequantized into the original float Conv/Gemm graph. This avoids ConvInteger,
which ONNX Runtime Web 1.14 cannot load, while keeping float activations and
preserving the upstream logits closely.

The extension uses the violence, weapon, and sensitive outputs. In the
upstream model card, violence includes physical harm/fighting/blood and
sensitive includes medical/blood contexts. SafeScroll combines the two blood
signals for its gore decision instead of treating every sensitive/medical
image as gore.
