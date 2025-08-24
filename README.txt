# Posture Checker Skeleton

このフォルダを GitHub Pages のリポジトリ直下にアップロードしてください。
- 手動プロット機能はすぐ動きます。
- AIを有効化するには以下のファイルを配置してください:

```
/vendor/
  tf.min.js                  ← TensorFlow.js UMDバンドル
  pose-detection.min.js      ← Pose Detection UMDバンドル
/models/movenet/
  model.json                 ← MoveNet model definition
  *.bin                      ← model.jsonに記載されている shard bin ファイルすべて
```

